import { promises as fs } from "node:fs";
import { atomicWrite, readJsonWithBackup } from "../storage/atomic-write.js";
import { journalPath, runJsonPath, runPath } from "../storage/paths.js";
import type { JournalEvent, WorkflowRun } from "./types.js";

export class PersistenceDegradedError extends Error {
	readonly code = "PERSISTENCE_DEGRADED";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "PersistenceDegradedError";
	}
}
const locks = new Map<string, Promise<void>>();
export class RunJournal {
	private seq = 0;
	constructor(
		public readonly runId: string,
		private readonly cwd = process.cwd(),
	) {}
	async append(
		event: Omit<JournalEvent, "schemaVersion" | "seq">,
	): Promise<JournalEvent> {
		const key = journalPath(this.runId, this.cwd);
		const prior = locks.get(key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queued = prior.then(() => gate);
		locks.set(key, queued);
		await prior;
		try {
			await fs.mkdir(runPath(this.runId, this.cwd), { recursive: true });
			const entries = await this.load();
			const entry: JournalEvent = {
				...event,
				schemaVersion: 2,
				seq: (entries.at(-1)?.seq ?? 0) + 1,
			};
			const handle = await fs.open(key, "a");
			try {
				await handle.writeFile(`${JSON.stringify(entry)}\n`);
				await handle.sync();
			} finally {
				await handle.close();
			}
			this.seq = entry.seq;
			return entry;
		} finally {
			release();
			if (locks.get(key) === queued) locks.delete(key);
		}
	}
	async load(): Promise<JournalEvent[]> {
		try {
			const text = await fs.readFile(journalPath(this.runId, this.cwd), "utf8");
			const entries = text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as JournalEvent);
			let expected = 1;
			for (const entry of entries) {
				if (
					entry.schemaVersion !== 2 ||
					entry.seq !== expected ||
					entry.runId !== this.runId
				)
					throw new PersistenceDegradedError("invalid journal sequence");
				expected++;
			}
			this.seq = entries.at(-1)?.seq ?? 0;
			return entries;
		} catch (error) {
			if (error instanceof PersistenceDegradedError) throw error;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new PersistenceDegradedError("journal is corrupt", {
				cause: error,
			});
		}
	}
	async snapshot(run: WorkflowRun): Promise<void> {
		run.journalSeq = Math.max(run.journalSeq ?? 0, this.seq);
		try {
			await atomicWrite(runJsonPath(this.runId, this.cwd), JSON.stringify(run));
		} catch (error) {
			throw new PersistenceDegradedError("snapshot failed", { cause: error });
		}
	}
	async persistRun(run: WorkflowRun): Promise<void> {
		await this.snapshot(run);
	}
	async restore(): Promise<{
		run?: WorkflowRun;
		source: "primary" | "backup" | "missing" | "corrupt";
	}> {
		return readJsonWithBackup<WorkflowRun>(runJsonPath(this.runId, this.cwd));
	}
}
