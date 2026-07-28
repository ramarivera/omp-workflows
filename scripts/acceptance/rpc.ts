import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

type JsonObject = Record<string, unknown>;
export type RpcFrame = JsonObject;
export type TranscriptEntry = {
	direction: "in" | "out";
	stream: "stdout" | "stderr" | "stdin";
	at: string;
	raw: string;
	frame?: RpcFrame;
};

export type ConfirmRequest = {
	id: string;
	method: "confirm";
	title?: string;
	message?: string;
};

export type RpcClientOptions = {
	command?: string;
	args: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	uiPolicy?: (request: ConfirmRequest) => boolean;
	onFrame?: (frame: RpcFrame) => void;
	timeoutMs?: number;
};

const isObject = (value: unknown): value is JsonObject =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);
const asFrame = (value: unknown): RpcFrame | undefined =>
	isObject(value) ? value : undefined;

export function frameText(frame: unknown): string {
	return JSON.stringify(frame);
}

export function extractHashFromApprovalMessage(message: string | undefined): string | undefined {
	if (!message) return undefined;
	try {
		const parsed = JSON.parse(message) as unknown;
		if (isObject(parsed) && typeof parsed.hash === "string" && /^[a-f0-9]{64}$/.test(parsed.hash)) return parsed.hash;
	} catch {
		// UI messages are allowed to contain a rendered preview; the fallback is intentionally strict.
	}
	const match = message.match(/\b[a-f0-9]{64}\b/);
	return match?.[0];
}

export class RawRpcClient {
	readonly transcript: TranscriptEntry[] = [];
	readonly frames: RpcFrame[] = [];
	readonly uiRequests: ConfirmRequest[] = [];
	readonly outbound: RpcFrame[] = [];
	private readonly pending = new Map<string, { resolve: (frame: RpcFrame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly readyWaiters: Array<() => void> = [];
	private readonly frameWaiters: Array<{ predicate: (frame: RpcFrame) => boolean; resolve: (frame: RpcFrame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
	private child?: ChildProcessWithoutNullStreams;
	private processExit?: { code: number | null; signal: NodeJS.Signals | null };
	private ready = false;
	private closed = false;
	private readonly timeoutMs: number;
	private readonly uiPolicy: (request: ConfirmRequest) => boolean;
	private readonly onFrame?: (frame: RpcFrame) => void;

	constructor(private readonly options: RpcClientOptions) {
		this.timeoutMs = options.timeoutMs ?? 120_000;
		this.uiPolicy = options.uiPolicy ?? (() => false);
		this.onFrame = options.onFrame;
	}

	start(): void {
		if (this.child) throw new Error("RPC client already started");
		this.child = spawn(this.options.command ?? "omp", this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout = createInterface({ input: this.child.stdout });
		// Dead-child EPIPE on stdin must not surface as an uncaught error event.
		this.child.stdin.on("error", () => {});
		stdout.on("line", (line) => this.ingest("stdout", line));
		const stderr = createInterface({ input: this.child.stderr });
		stderr.on("line", (line) => this.ingest("stderr", line));
		this.child.on("error", (error) => {
			this.processExit = { code: null, signal: null };
			this.rejectAll(new Error(`omp process error: ${error.message}`));
		});
		this.child.on("close", (code, signal) => {
			this.processExit = { code, signal };
			this.closed = true;
			this.rejectAll(new Error(`omp RPC exited (${code ?? "null"}/${signal ?? "none"})`));
		});
	}

	private ingest(stream: "stdout" | "stderr", raw: string): void {
		const frame = stream === "stdout" ? this.parse(raw) : undefined;
		this.transcript.push({ direction: "in", stream, at: new Date().toISOString(), raw, frame });
		if (!frame) return;
		this.frames.push(frame);
		if (frame.type === "ready") {
			this.ready = true;
			for (const resolve of this.readyWaiters.splice(0)) resolve();
		}
		if (frame.type === "extension_ui_request" && frame.method === "confirm" && typeof frame.id === "string") {
			const request: ConfirmRequest = { id: frame.id, method: "confirm", title: typeof frame.title === "string" ? frame.title : undefined, message: typeof frame.message === "string" ? frame.message : undefined };
			this.uiRequests.push(request);
			this.write({ type: "extension_ui_response", id: request.id, confirmed: this.uiPolicy(request) });
		}
		if (frame.type === "rpc_chunk") return;
		if (frame.type === "response" && typeof frame.id === "string") {
			const pending = this.pending.get(frame.id);
			if (pending) {
				this.pending.delete(frame.id);
				clearTimeout(pending.timer);
				pending.resolve(frame);
			}
		}
		for (let i = this.frameWaiters.length - 1; i >= 0; i--) {
			const waiter = this.frameWaiters[i];
			if (!waiter.predicate(frame)) continue;
			this.frameWaiters.splice(i, 1);
			clearTimeout(waiter.timer);
			waiter.resolve(frame);
		}
		this.onFrame?.(frame);
	}

	private parse(raw: string): RpcFrame | undefined {
		try {
			return asFrame(JSON.parse(raw));
		} catch {
			return undefined;
		}
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const waiter of this.frameWaiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
	}

	waitForReady(timeoutMs = this.timeoutMs): Promise<void> {
		if (this.ready) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for RPC ready")), timeoutMs);
			this.readyWaiters.push(() => { clearTimeout(timer); resolve(); });
		});
	}

	send(command: JsonObject, timeoutMs = this.timeoutMs): Promise<RpcFrame> {
		if (!this.child || this.closed) return Promise.reject(new Error("RPC process is not running"));
		const id = typeof command.id === "string" ? command.id : randomUUID();
		const frame = { ...command, id };
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`timed out waiting for RPC response ${id}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.write(frame);
		});
	}

	sendAndIgnore(command: JsonObject): void {
		this.send(command).catch(() => undefined);
	}

	private write(frame: JsonObject): void {
		if (!this.child || this.closed) return;
		const raw = frameText(frame);
		this.outbound.push(frame);
		this.transcript.push({ direction: "out", stream: "stdin", at: new Date().toISOString(), raw, frame });
		this.child.stdin.write(`${raw}\n`);
	}

	async initialize(expectedTools = ["workflow_stage", "workflow_control"]): Promise<void> {
		await this.waitForReady();
		await this.send({ type: "negotiate_protocol", protocolVersion: 2 });
		await this.send({ type: "set_subagent_subscription", level: "events" });
		const commands = await this.send({ type: "get_available_commands" });
		const state = await this.send({ type: "get_state" });
		const commandText = JSON.stringify(commands.data ?? commands);
		const stateText = JSON.stringify(state.data ?? state);
		if (!(commandText.includes("workflow") && expectedTools.every((tool) => stateText.includes(tool)))) {
			throw new Error("workflow extension registration was not observed in RPC command/state frames");
		}
	}

	waitForFrame(predicate: (frame: RpcFrame) => boolean, timeoutMs = this.timeoutMs): Promise<RpcFrame> {
		const found = this.frames.find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for RPC frame")), timeoutMs);
			this.frameWaiters.push({ predicate, resolve, reject, timer });
		});
	}

	async prompt(message: string, timeoutMs = this.timeoutMs): Promise<RpcFrame> {
		const response = await this.send({ type: "prompt", message }, timeoutMs);
		if (response.success === false) throw new Error(String(response.error ?? "prompt rejected"));
		return response;
	}

	async waitForIdle(timeoutMs = this.timeoutMs): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const state = await this.send({ type: "get_state" }, Math.min(timeoutMs, 10_000));
			const data = isObject(state.data) ? state.data : state;
			if (data.isStreaming !== true && data.isCompacting !== true) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		throw new Error("timed out waiting for agent idle");
	}

	/** SIGKILL without closing stdin first; simulates a crash for recovery scenarios. */
	async hardKill(graceMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		if (!this.child) return this.processExit ?? { code: null, signal: null };
		if (!this.closed) {
			this.child.kill("SIGKILL");
			const deadline = Date.now() + graceMs;
			while (!this.closed && Date.now() < deadline)
				await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
		}
		return this.processExit ?? { code: null, signal: null };
	}

	async terminate(graceMs = 5_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		if (!this.child) return this.processExit ?? { code: null, signal: null };
		if (!this.closed) {
			this.child.stdin.end();
			let deadline = Date.now() + graceMs;
			while (!this.closed && Date.now() < deadline)
				await delay(25);
			if (!this.closed) {
				this.child.kill("SIGTERM");
				deadline = Date.now() + graceMs;
				while (!this.closed && Date.now() < deadline)
					await delay(25);
			}
			if (!this.closed) {
				this.child.kill("SIGKILL");
				deadline = Date.now() + Math.min(graceMs, 1_000);
				while (!this.closed && Date.now() < deadline)
					await delay(25);
			}
		}
		return this.processExit ?? { code: null, signal: null };
	}
}
