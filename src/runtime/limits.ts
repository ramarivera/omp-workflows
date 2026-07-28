import type { WorkflowLimits } from "./types.js";

export interface LimitSnapshot {
	agents: number;
	outputTokens: number;
	runtimeMs: number;
	active: number;
	queued: number;
}

export interface SharedLimitState {
	agents?: number;
	outputTokens?: number;
	startedAt?: number;
	lastProgressAt?: number;
	now?: () => number;
}

export class WorkflowLimitError extends Error {
	readonly code = "WORKFLOW_LIMIT";

	constructor(
		readonly limit: keyof WorkflowLimits,
		message: string,
	) {
		super(message);
		this.name = "WorkflowLimitError";
	}
}

interface Waiter {
	resolve: () => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	abort?: () => void;
}

export class SharedLimits {
	private active = 0;
	private agents: number;
	private outputTokens: number;
	private readonly started: number;
	private lastProgress: number;
	private readonly now: () => number;
	private readonly queue: Waiter[] = [];

	constructor(
		public readonly limits: WorkflowLimits = {},
		private readonly parent?: SharedLimits,
		state: SharedLimitState = {},
	) {
		this.now = state.now ?? Date.now;
		this.started = state.startedAt ?? this.now();
		this.lastProgress = state.lastProgressAt ?? this.started;
		this.agents = state.agents ?? 0;
		this.outputTokens = state.outputTokens ?? 0;
	}

	private get root(): SharedLimits {
		return this.parent?.root ?? this;
	}

	async acquireAgent(signal?: AbortSignal): Promise<() => void> {
		const root = this.root;
		root.check();
		if (
			root.limits.maxAgents !== undefined &&
			root.agents >= root.limits.maxAgents
		) {
			throw new WorkflowLimitError(
				"maxAgents",
				"maximum workflow agents exceeded",
			);
		}
		root.agents += 1;

		if (
			root.limits.maxConcurrency !== undefined &&
			root.active >= root.limits.maxConcurrency
		) {
			await new Promise<void>((resolve, reject) => {
				const waiter: Waiter = { resolve, reject, signal };
				let settled = false;
				waiter.abort = () => {
					if (settled) return;
					settled = true;
					const index = root.queue.indexOf(waiter);
					if (index >= 0) root.queue.splice(index, 1);
					root.agents -= 1;
					reject(new Error("workflow aborted while queued"));
				};
				if (signal) {
					if (signal.aborted) {
						waiter.abort();
						return;
					}
					signal.addEventListener("abort", waiter.abort, { once: true });
				}
				root.queue.push(waiter);
			});
		}

		root.active += 1;
		root.progress();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			root.active -= 1;
			const next = root.queue.shift();
			if (next) {
				if (next.signal && next.abort)
					next.signal.removeEventListener("abort", next.abort);
				next.resolve();
			}
		};
	}

	consumeTokens(count: number): void {
		const root = this.root;
		root.outputTokens += count;
		root.progress();
		if (
			root.limits.maxOutputTokens !== undefined &&
			root.outputTokens > root.limits.maxOutputTokens
		) {
			throw new WorkflowLimitError(
				"maxOutputTokens",
				"maximum workflow output tokens exceeded",
			);
		}
	}

	progress(): void {
		this.root.lastProgress = this.root.now();
	}

	check(): void {
		const root = this.root;
		const now = root.now();
		if (
			root.limits.maxRuntimeMs !== undefined &&
			now - root.started >= root.limits.maxRuntimeMs
		) {
			throw new WorkflowLimitError(
				"maxRuntimeMs",
				"maximum workflow runtime exceeded",
			);
		}
		if (
			root.limits.maxIdleMs !== undefined &&
			now - root.lastProgress >= root.limits.maxIdleMs
		) {
			throw new WorkflowLimitError(
				"maxIdleMs",
				"maximum workflow idle time exceeded",
			);
		}
		if (
			root.limits.maxNoProgressMs !== undefined &&
			now - root.lastProgress >= root.limits.maxNoProgressMs
		) {
			throw new WorkflowLimitError(
				"maxNoProgressMs",
				"maximum workflow no-progress time exceeded",
			);
		}
	}

	remainingRuntimeMs(): number | undefined {
		const root = this.root;
		if (root.limits.maxRuntimeMs === undefined) return undefined;
		return Math.max(0, root.limits.maxRuntimeMs - (root.now() - root.started));
	}

	snapshot(): LimitSnapshot {
		const root = this.root;
		return {
			agents: root.agents,
			outputTokens: root.outputTokens,
			runtimeMs: Math.max(0, root.now() - root.started),
			active: root.active,
			queued: root.queue.length,
		};
	}

	get totals(): { outputTokens: number; agents: number; runtimeMs: number } {
		const snapshot = this.snapshot();
		return {
			outputTokens: snapshot.outputTokens,
			agents: snapshot.agents,
			runtimeMs: snapshot.runtimeMs,
		};
	}

	child(limits: WorkflowLimits = {}): SharedLimits {
		return new SharedLimits(limits, this.root);
	}
}
