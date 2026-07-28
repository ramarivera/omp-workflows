import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parse } from "acorn";
import { simple } from "acorn-walk";
import type {
	WorkflowApprovalCall,
	WorkflowApprovalPreview,
	WorkflowApprovalRecord,
	WorkflowSource,
} from "../definition/types.js";
import {
	assertValidArguments,
	assertValidDefinition,
} from "../definition/validation.js";
import { validateSourcePolicy } from "../generation/index.js";
import type { WorkflowDefinition } from "../runtime/types.js";
import { PLUGIN_VERSION } from "../version.js";
import type { WorkflowUiMode } from "./mode.js";

type AstNode = Record<string, unknown>;

export interface ApprovalQuery {
	hash?: string;
	workflowId?: string;
	sourcePath?: string;
	scope?: "project" | "user";
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function staticValue(value: unknown): unknown {
	if (!value || typeof value !== "object") return undefined;
	const node = value as AstNode;
	if (node.type === "Literal") return node.value;
	if (
		node.type === "TemplateLiteral" &&
		Array.isArray(node.expressions) &&
		node.expressions.length === 0 &&
		Array.isArray(node.quasis)
	) {
		return node.quasis
			.map((quasi) => {
				const record = quasi as AstNode;
				const cooked = record.value as AstNode | undefined;
				return typeof cooked?.cooked === "string" ? cooked.cooked : "";
			})
			.join("");
	}
	if (node.type === "ArrayExpression" && Array.isArray(node.elements)) {
		return node.elements.map(staticValue);
	}
	if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
		const record: Record<string, unknown> = {};
		for (const rawProperty of node.properties) {
			const property = rawProperty as AstNode;
			if (
				property.type !== "Property" ||
				property.computed ||
				property.kind !== "init"
			) {
				return undefined;
			}
			const keyNode = property.key as AstNode;
			const key = keyNode.name ?? keyNode.value;
			if (typeof key !== "string") return undefined;
			record[key] = staticValue(property.value);
		}
		return record;
	}
	return undefined;
}

function callName(node: AstNode): string | undefined {
	const callee = node.callee as AstNode | undefined;
	if (callee?.type === "Identifier" && typeof callee.name === "string") {
		return callee.name;
	}
	if (
		callee?.type === "MemberExpression" &&
		callee.computed !== true &&
		callee.property &&
		typeof (callee.property as AstNode).name === "string"
	) {
		return (callee.property as AstNode).name as string;
	}
	return undefined;
}

function analyzeSource(source: string): {
	phases: string[];
	calls: WorkflowApprovalCall[];
} {
	const javascript =
		typeof Bun === "undefined"
			? source
			: new Bun.Transpiler({ loader: "ts" }).transformSync(source);
	const tree = parse(javascript, {
		ecmaVersion: "latest",
		sourceType: "module",
	});
	const phases: string[] = [];
	const calls: WorkflowApprovalCall[] = [];

	simple(tree, {
		CallExpression: (rawNode: unknown) => {
			const node = rawNode as AstNode;
			const name = callName(node);
			const args = Array.isArray(node.arguments) ? node.arguments : [];
			if (name === "phase") {
				const title = staticValue(args[0]);
				if (typeof title === "string") phases.push(title);
				return;
			}
			if (name !== "agent") return;
			const prompt = staticValue(args[0]);
			const options = staticValue(args[1]);
			const optionRecord =
				options && typeof options === "object"
					? (options as Record<string, unknown>)
					: {};
			calls.push({
				id: typeof optionRecord.id === "string" ? optionRecord.id : undefined,
				prompt: typeof prompt === "string" ? prompt : undefined,
				agent:
					typeof optionRecord.agent === "string"
						? optionRecord.agent
						: undefined,
				model:
					typeof optionRecord.model === "string"
						? optionRecord.model
						: undefined,
				effort:
					typeof optionRecord.effort === "string"
						? optionRecord.effort
						: undefined,
				fallbacks: Array.isArray(optionRecord.fallbacks)
					? optionRecord.fallbacks.filter(
							(entry): entry is string => typeof entry === "string",
						)
					: [],
				toolset: Array.isArray(optionRecord.toolset)
					? optionRecord.toolset.filter(
							(entry): entry is string => typeof entry === "string",
						)
					: typeof optionRecord.toolset === "string"
						? [optionRecord.toolset]
						: [],
				isolation: optionRecord.isolation,
				apply:
					typeof optionRecord.apply === "boolean"
						? optionRecord.apply
						: undefined,
			});
		},
	});
	return { phases, calls };
}

function previewTuple(
	preview: WorkflowApprovalPreview,
): Omit<WorkflowApprovalPreview, "hash"> {
	const { hash: _hash, ...tuple } = preview;
	return tuple;
}
function withoutHash(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return value;
	}
	const copy = { ...(value as Record<string, unknown>) };
	delete copy.hash;
	return copy;
}

export function workflowHash(source: string, tuple: unknown): string {
	return createHash("sha256")
		.update(canonical({ source, tuple }))
		.digest("hex");
}

export function createApprovalPreview(
	source: string,
	definition: WorkflowDefinition,
	args: unknown,
	details: {
		model?: unknown;
		effort?: unknown;
		toolset?: string[];
		isolation?: unknown;
		apply?: unknown;
		pluginSource?: string;
		runtimeVersion?: string;
		fallbacks?: unknown;
		source?: WorkflowSource;
		filesystem?: string[];
	},
): WorkflowApprovalPreview {
	assertValidDefinition(definition);
	assertValidArguments(definition.args, args);
	validateSourcePolicy(source);
	const toolset = details.toolset ?? [];
	const runtime = details.runtimeVersion ?? PLUGIN_VERSION;
	const analysis = analyzeSource(source);
	const previewWithoutHash: Omit<WorkflowApprovalPreview, "hash"> = {
		rawSource: source,
		args,
		phases: analysis.phases,
		calls: analysis.calls,
		routing: {
			model: details.model,
			effort: details.effort,
			fallbacks: details.fallbacks,
			calls: analysis.calls.map((call) => ({
				id: call.id,
				agent: call.agent,
				model: call.model,
				effort: call.effort,
				fallbacks: call.fallbacks,
			})),
		},
		limits: definition.limits ?? {},
		filesystem: details.filesystem ?? [],
		pluginSource: details.pluginSource,
		toolset,
		versions: { runtime, definition: definition.version },
		source: details.source ?? { path: "", scope: "project" },
		metadata: {
			name: definition.name,
			version: definition.version,
			schema: definition.args,
		},
		model: details.model,
		effort: details.effort,
		isolation: details.isolation,
		apply: details.apply,
		fallbacks: details.fallbacks,
	};
	return {
		...previewWithoutHash,
		hash: workflowHash(source, previewWithoutHash),
	};
}

function validRecord(value: unknown): value is WorkflowApprovalRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.workflowId === "string" &&
		typeof record.hash === "string" &&
		/^[0-9a-f]{64}$/.test(record.hash) &&
		typeof record.approvedAt === "string" &&
		(record.scope === "project" || record.scope === "user") &&
		typeof record.sourcePath === "string" &&
		Array.isArray(record.toolset) &&
		typeof record.runtimeVersion === "string" &&
		!!record.tuple &&
		typeof record.tuple === "object"
	);
}

export class ApprovalStore {
	constructor(private readonly path: string) {}

	async approve(
		preview: WorkflowApprovalPreview,
		scope: "project" | "user",
		sourcePath: string,
	): Promise<WorkflowApprovalRecord> {
		if (sourcePath !== preview.source.path) {
			throw new Error("Approval source path does not match preview");
		}
		const tuple = previewTuple(preview);
		if (workflowHash(preview.rawSource, tuple) !== preview.hash) {
			throw new Error("Approval preview hash is invalid");
		}
		if ((await readFile(resolve(sourcePath), "utf8")) !== preview.rawSource) {
			throw new Error("Workflow source changed before approval");
		}
		const record: WorkflowApprovalRecord = {
			workflowId: `${preview.metadata.name}:${preview.metadata.version}`,
			hash: preview.hash,
			approvedAt: new Date().toISOString(),
			scope,
			sourcePath,
			toolset: [...preview.toolset],
			runtimeVersion: preview.versions.runtime,
			tuple: structuredClone(preview),
		};
		const records = (await this.read()).filter(
			(candidate) => candidate.hash !== record.hash,
		);
		records.push(record);
		await this.write(records);
		return structuredClone(record);
	}

	async list(): Promise<WorkflowApprovalRecord[]> {
		return structuredClone(await this.read());
	}

	async find(
		query: string | ApprovalQuery,
	): Promise<WorkflowApprovalRecord | undefined> {
		const criteria = typeof query === "string" ? { hash: query } : query;
		const records = await this.read();
		const found = records.find((record) => {
			if (criteria.hash !== undefined && record.hash !== criteria.hash) {
				return false;
			}
			if (
				criteria.workflowId !== undefined &&
				record.workflowId !== criteria.workflowId
			) {
				return false;
			}
			if (
				criteria.sourcePath !== undefined &&
				record.sourcePath !== criteria.sourcePath
			) {
				return false;
			}
			return criteria.scope === undefined || record.scope === criteria.scope;
		});
		return found ? structuredClone(found) : undefined;
	}

	async get(hash: string): Promise<WorkflowApprovalRecord | undefined> {
		return this.find(hash);
	}

	async verify(preview: WorkflowApprovalPreview): Promise<boolean> {
		const record = await this.find(preview.hash);
		if (!record) return false;
		if (
			record.sourcePath !== preview.source.path ||
			record.tuple === undefined
		) {
			return false;
		}
		if (
			workflowHash(preview.rawSource, previewTuple(preview)) !== preview.hash
		) {
			return false;
		}
		let sourceText: string;
		try {
			sourceText = await readFile(resolve(record.sourcePath), "utf8");
		} catch {
			return false;
		}
		if (sourceText !== preview.rawSource) return false;
		const recordTuple = withoutHash(record.tuple);
		return (
			workflowHash(sourceText, recordTuple) === record.hash &&
			canonical(recordTuple) === canonical(previewTuple(preview))
		);
	}

	async isApproved(
		hash: string,
		preview?: WorkflowApprovalPreview,
	): Promise<boolean> {
		if (preview) return this.verify(preview);
		return !!(await this.find(hash));
	}

	async revoke(hash: string): Promise<void> {
		await this.write(
			(await this.read()).filter((record) => record.hash !== hash),
		);
	}

	async saveApproved(
		preview: WorkflowApprovalPreview,
		targetDir: string,
	): Promise<string> {
		if (preview.source.scope === "plugin") {
			throw new Error("Plugin workflows are read-only");
		}
		if (!(await this.verify(preview))) {
			throw new Error("Exact workflow approval tuple is not approved");
		}
		const source = resolve(preview.source.path);
		const sourceText = await readFile(source, "utf8");
		if (
			sourceText !== preview.rawSource ||
			workflowHash(sourceText, previewTuple(preview)) !== preview.hash
		) {
			throw new Error("Workflow source changed after approval");
		}
		const root = resolve(targetDir);
		const target = resolve(root, `${preview.metadata.name}.ts`);
		const rel = relative(root, target);
		if (rel.startsWith("..") || resolve(root, rel) !== target) {
			throw new Error("Target path escapes destination");
		}
		await mkdir(dirname(target), { recursive: true });
		const temporary = `${target}.${randomUUID()}.tmp`;
		await copyFile(source, temporary);
		await rename(temporary, target);
		return target;
	}

	private async write(records: WorkflowApprovalRecord[]): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(records, null, 2), {
			encoding: "utf8",
			flag: "wx",
		});
		await rename(temporary, this.path);
	}

	private async read(): Promise<WorkflowApprovalRecord[]> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(this.path, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new Error("Malformed approval store", { cause: error });
		}
		if (!Array.isArray(parsed) || parsed.some((item) => !validRecord(item))) {
			throw new Error("Malformed approval store");
		}
		return parsed;
	}
}

export const APPROVAL_CONFIRM_TITLE = "Approve workflow execution";

/**
 * Renders a workflow approval preview as a human-readable confirmation
 * message. The exact `preview.rawSource` (full workflow program, verbatim)
 * and the exact 64-char SHA-256 `preview.hash` are preserved without
 * rewriting so the operator can copy-and-verify both values. The format is
 * mode-aware: operator mode emits a compact, scannable block; dashboard
 * mode emits a framed card with explicit sections. Output is plain text —
 * no ANSI color — and stays legible in a fixed-width terminal of ~78
 * columns.
 */
export function formatApprovalMessage(
	preview: WorkflowApprovalPreview,
	mode: WorkflowUiMode = "operator",
): string {
	const lines: string[] = [];
	if (mode === "dashboard") {
		lines.push(
			"┌─ workflow approval ────────────────────────────────────────────┐",
		);
		lines.push(
			`│ ${preview.metadata.name}@${preview.metadata.version} · ${preview.source.scope}`,
		);
		lines.push(
			`│ identity: ${preview.metadata.name}@${preview.metadata.version} · scope ${preview.source.scope} · ${preview.source.path}`,
		);
		lines.push(
			`│ versions: runtime ${preview.versions.runtime} · definition ${preview.versions.definition}`,
		);
		lines.push(`│ phases: ${preview.phases.length}`);
		lines.push(`│ calls: ${preview.calls.length}`);
		lines.push(
			`│ routing: model ${preview.model ?? "default"} · effort ${preview.effort ?? "default"} · fallbacks ${Array.isArray(preview.fallbacks) ? preview.fallbacks.length : 0}`,
		);
		lines.push(
			`│ toolsets: ${preview.toolset.length === 0 ? "none" : preview.toolset.join(", ")}`,
		);
		lines.push(
			`│ isolation: ${typeof preview.isolation === "string" ? preview.isolation : preview.isolation ? JSON.stringify(preview.isolation) : "default"}`,
		);
		lines.push(`│ apply: ${preview.apply === true ? "true" : "false"}`);
		lines.push(
			`│ limits: concurrency ${preview.limits.maxConcurrency ?? "∞"} · agents ${preview.limits.maxAgents ?? "∞"} · tokens ${preview.limits.maxOutputTokens ?? "∞"} · runtime ${preview.limits.maxRuntimeMs ?? "∞"}`,
		);
		lines.push(`│ args: ${JSON.stringify(preview.args)}`);
		lines.push(`│ sha-256: ${preview.hash}`);
		lines.push("│ source: full program follows verbatim below");
		lines.push(
			"└──────────────────────────────────────────────────────────────┘",
		);
		lines.push("source (verbatim):");
		lines.push(preview.rawSource);
		lines.push("approve by typing 'yes' · anything else declines");
		return lines.join("\n");
	}
	lines.push(`workflow ${preview.metadata.name}@${preview.metadata.version}`);
	lines.push(
		`identity: ${preview.metadata.name}@${preview.metadata.version} · ${preview.source.scope} · ${preview.source.path}`,
	);
	lines.push(
		`versions: runtime ${preview.versions.runtime} · definition ${preview.versions.definition}`,
	);
	lines.push(
		`phases: ${preview.phases.length === 0 ? "(none)" : preview.phases.map((phase) => phase).join(", ")}`,
	);
	lines.push(`calls: ${preview.calls.length}`);
	if (preview.calls.length > 0) {
		for (const [index, call] of preview.calls.entries()) {
			const id = call.id ?? `call-${index}`;
			const agent = call.agent ?? "default";
			const model = call.model ?? "default";
			const effort = call.effort ?? "default";
			const toolset =
				call.toolset.length === 0 ? "default" : call.toolset.join(",");
			const isolation = call.isolation
				? typeof call.isolation === "string"
					? call.isolation
					: JSON.stringify(call.isolation)
				: "default";
			const apply = call.apply === true ? "apply" : "no-apply";
			lines.push(
				`  ${index + 1}. ${id} · ${agent} · model ${model} · effort ${effort} · toolset ${toolset} · isolation ${isolation} · ${apply}`,
			);
		}
	}
	lines.push(
		`routing: model ${preview.model ?? "default"} · effort ${preview.effort ?? "default"} · fallbacks ${Array.isArray(preview.fallbacks) ? preview.fallbacks.length : 0}`,
	);
	lines.push(
		`toolsets: ${preview.toolset.length === 0 ? "default" : preview.toolset.join(", ")}`,
	);
	lines.push(
		`isolation: ${typeof preview.isolation === "string" ? preview.isolation : preview.isolation ? JSON.stringify(preview.isolation) : "default"}`,
	);
	lines.push(`apply: ${preview.apply === true ? "yes" : "no"}`);
	lines.push(
		`limits: concurrency ${preview.limits.maxConcurrency ?? "∞"} · agents ${preview.limits.maxAgents ?? "∞"} · tokens ${preview.limits.maxOutputTokens ?? "∞"} · runtime ${preview.limits.maxRuntimeMs ?? "∞"}`,
	);
	lines.push(`args: ${JSON.stringify(preview.args)}`);
	lines.push(`sha-256: ${preview.hash}`);
	lines.push(`source (verbatim):`);
	lines.push(preview.rawSource);
	lines.push("approve by typing 'yes' · anything else declines");
	return lines.join("\n");
}
