import { createHash } from "node:crypto";
import type { WorkflowCall } from "./types.js";

export function canonicalize(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(canonicalize);
	const object = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(object)
			.sort()
			.map((key) => [key, canonicalize(object[key])]),
	);
}

export function canonicalSerialize(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

export function canonicalInputHash(input: unknown): string {
	return createHash("sha256").update(canonicalSerialize(input)).digest("hex");
}

export interface ReplayProbe {
	hit: boolean;
	value?: unknown;
	call?: WorkflowCall;
}

export class ReplayCache {
	private prefix = -1;
	private invalidated = false;
	private readonly indexed: Map<number, WorkflowCall>;

	constructor(
		calls: WorkflowCall[],
		private readonly namespace: string,
	) {
		this.indexed = new Map(
			calls
				.filter((call) => call.namespace === namespace)
				.map((call) => [call.index, structuredClone(call)]),
		);
	}

	probe(index: number, inputHash: string): ReplayProbe {
		if (this.invalidated || index !== this.prefix + 1) return { hit: false };
		const call = this.indexed.get(index);
		if (
			!call ||
			call.inputHash !== inputHash ||
			!["succeeded", "cached"].includes(call.status)
		) {
			this.invalidated = true;
			return { hit: false };
		}
		this.prefix = index;
		return { hit: true, value: call.result, call: structuredClone(call) };
	}

	lookup(index: number, inputHash: string): unknown | undefined {
		return this.probe(index, inputHash).value;
	}

	has(index: number, inputHash: string): boolean {
		if (this.invalidated || index !== this.prefix + 1) return false;
		const call = this.indexed.get(index);
		return Boolean(
			call &&
				call.inputHash === inputHash &&
				["succeeded", "cached"].includes(call.status),
		);
	}

	invalidateFrom(index: number): void {
		for (const key of [...this.indexed.keys()]) {
			if (key >= index) this.indexed.delete(key);
		}
		this.invalidated = true;
	}

	get longestPrefix(): number {
		return this.prefix;
	}
}
