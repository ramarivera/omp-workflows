import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface LeaseRecord {
	token: string;
	generation: number;
	pid: number;
	at: number;
}

export class LeaseUnavailableError extends Error {
	readonly code = "LEASE_UNAVAILABLE";

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "LeaseUnavailableError";
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export class Lease {
	private constructor(
		public readonly path: string,
		private readonly handle: fs.FileHandle,
		public readonly record: LeaseRecord,
	) {}

	static async acquire(file: string, generation = 1): Promise<Lease> {
		await fs.mkdir(path.dirname(file), { recursive: true });
		const record: LeaseRecord = {
			token: randomUUID(),
			generation,
			pid: process.pid,
			at: Date.now(),
		};

		try {
			const handle = await fs.open(file, "wx");
			try {
				await handle.writeFile(JSON.stringify(record));
				await handle.sync();
			} catch (error) {
				await handle.close();
				throw error;
			}
			return new Lease(file, handle, record);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const original = await fs.readFile(file, "utf8").catch(() => undefined);
			if (!original) {
				throw new LeaseUnavailableError(`lease ${file} is unavailable`, {
					cause: error,
				});
			}
			let incumbent: LeaseRecord;
			try {
				incumbent = JSON.parse(original) as LeaseRecord;
			} catch {
				throw new LeaseUnavailableError(`lease ${file} is malformed`, {
					cause: error,
				});
			}
			if (processIsAlive(incumbent.pid)) {
				throw new LeaseUnavailableError(
					`lease ${file} is owned by live process ${incumbent.pid}`,
					{ cause: error },
				);
			}
			const current = await fs.readFile(file, "utf8").catch(() => undefined);
			if (current !== original) {
				throw new LeaseUnavailableError(
					`lease ${file} changed during recovery`,
					{
						cause: error,
					},
				);
			}
			await fs.unlink(file);
			return Lease.acquire(file, generation);
		}
	}

	async assert(generation = this.record.generation): Promise<void> {
		const current = JSON.parse(
			await fs.readFile(this.path, "utf8"),
		) as LeaseRecord;
		if (
			current.token !== this.record.token ||
			current.generation !== this.record.generation ||
			generation !== current.generation
		) {
			throw new LeaseUnavailableError("stale lease owner");
		}
	}

	async release(token = this.record.token): Promise<void> {
		if (token !== this.record.token)
			throw new LeaseUnavailableError("wrong lease token");
		await this.assert();
		await this.handle.close();
		await fs.unlink(this.path);
	}
}

export async function withLease<T>(
	file: string,
	operation: (lease: Lease) => Promise<T>,
	generation = 1,
): Promise<T> {
	const lease = await Lease.acquire(file, generation);
	try {
		return await operation(lease);
	} finally {
		await lease.release().catch(() => undefined);
	}
}
