import path from "node:path";
import { Lease } from "../storage/lease.js";
import { runPath } from "../storage/paths.js";
import type {
	JournalEvent,
	WorkflowEvent,
	WorkflowRun,
	WorkflowRunStatus,
} from "./types.js";

export interface RunJournalLike {
	append(
		event: Omit<JournalEvent, "schemaVersion" | "seq">,
	): Promise<JournalEvent>;
	snapshot(run: WorkflowRun): Promise<void>;
}
export type EventSink = (event: WorkflowEvent) => void | Promise<void>;
export interface RunStateOptions {
	clock?: () => number;
	leasePath?: string;
}

export class RunStateCoordinator<A = unknown> {
	private state: WorkflowRun<A>;
	private readonly clock: () => number;
	private lease?: Lease;
	private fenced = false;
	constructor(
		run: WorkflowRun<A>,
		private readonly journal: RunJournalLike,
		private readonly generation: number,
		private readonly token: string,
		private readonly sink: EventSink,
		options: RunStateOptions = {},
	) {
		this.state = structuredClone(run);
		this.clock = options.clock ?? Date.now;
		this.leasePath = options.leasePath ?? path.join(runPath(run.id), "lease");
	}
	private readonly leasePath: string;
	get snapshot(): WorkflowRun<A> {
		return structuredClone(this.state);
	}
	private assertOwner(): void {
		if (
			this.fenced ||
			this.state.controllerGeneration !== this.generation ||
			this.state.fencingToken !== this.token
		)
			throw new Error("stale fencing owner");
	}
	async acquire(): Promise<Lease> {
		if (this.lease) {
			await this.lease.assert(this.generation);
			return this.lease;
		}
		this.lease = await Lease.acquire(this.leasePath, this.generation);
		return this.lease;
	}
	async renew(): Promise<void> {
		this.assertOwner();
		if (!this.lease) throw new Error("lease not acquired");
		try {
			await this.lease.assert(this.generation);
		} catch (error) {
			this.fenced = true;
			throw error;
		}
	}
	async release(token?: string): Promise<void> {
		if (!this.lease) throw new Error("lease not acquired");
		const leaseToken = token ?? this.lease.record.token;
		if (leaseToken !== this.lease.record.token)
			throw new Error("wrong lease token");
		await this.lease.release(leaseToken);
		this.lease = undefined;
	}
	private async publish(type: string, payload?: unknown): Promise<void> {
		await this.sink({
			type,
			runId: this.state.id,
			data: payload,
			at: this.clock(),
		});
	}
	async transition(
		status: WorkflowRunStatus,
		payload?: unknown,
	): Promise<WorkflowRun<A>> {
		this.assertOwner();
		const next = structuredClone(this.state);
		next.status = status;
		next.updatedAt = this.clock();
		try {
			await this.journal.append({
				type: "status_changed",
				runId: next.id,
				payload: {
					status,
					...(payload && typeof payload === "object"
						? payload
						: { value: payload }),
				},
				at: next.updatedAt,
			});
			await this.journal.snapshot(next);
			this.state = next;
			await this.publish("status_changed", payload);
			return this.snapshot;
		} catch (error) {
			await this.degrade(error);
			throw error;
		}
	}
	async record(type: string, payload?: unknown): Promise<WorkflowRun<A>> {
		this.assertOwner();
		const changed = payload !== undefined;
		const next = structuredClone(this.state);
		next.updatedAt = this.clock();
		try {
			await this.journal.append({
				type,
				runId: next.id,
				payload,
				at: next.updatedAt,
			});
			if (changed) await this.journal.snapshot(next);
			if (changed) this.state = next;
			if (changed) await this.publish(type, payload);
			return this.snapshot;
		} catch (error) {
			await this.degrade(error);
			throw error;
		}
	}
	private async degrade(cause: unknown): Promise<void> {
		this.state.status = "persistence_degraded";
		this.state.persistenceHealth = "degraded";
		this.state.updatedAt = this.clock();
		try {
			await this.journal.append({
				type: "persistence_degraded",
				runId: this.state.id,
				payload: {
					message: cause instanceof Error ? cause.message : String(cause),
				},
				at: this.state.updatedAt,
			});
		} catch {}
		try {
			await this.publish("persistence_degraded", {
				cause: cause instanceof Error ? cause.message : String(cause),
			});
		} catch {}
	}
}
