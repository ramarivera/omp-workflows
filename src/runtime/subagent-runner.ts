import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	applyGitPatch,
	captureGitChanges,
	withIntegration,
} from "./git-isolation.js";

const exec = promisify(execFile);
const BUILTIN_TOOLSETS: Readonly<Record<string, readonly string[]>> = {
	"repo-read": ["read", "grep", "glob", "lsp"],
	"repo-write": ["read", "grep", "glob", "lsp", "edit", "write", "bash"],
	"web-research": ["read", "web_search"],
};
const MODEL_ALIASES: Readonly<Record<string, string>> = {
	fast: "@smol",
	coding: "@task",
	review: "@task",
	research: "@slow",
	reasoning: "@slow",
};
const EFFORT_ALIASES: Readonly<Record<string, string>> = {
	low: "lo",
	medium: "med",
	high: "hi",
};

import {
	type AgentDefinition,
	type AgentProgress,
	type ModelRegistry,
	runSubprocess,
	type Settings,
	type SingleResult,
} from "@oh-my-pi/pi-coding-agent";

type SubprocessOptions = Parameters<typeof runSubprocess>[0];

import type {
	AgentRequest,
	AgentResult,
	WorkflowEvent,
	WorkflowHost,
	WorkflowIsolation,
} from "./types.js";

export interface SubprocessRunnerDeps {
	cwd: string;
	modelRegistry?: ModelRegistry;
	settings?: Settings;
	artifacts?: SubprocessOptions["parentArtifactManager"];
	resolveAgent?: (name: string | undefined) => AgentDefinition;
	subprocess?: (options: SubprocessOptions) => Promise<SingleResult>;
	toolset?: unknown;
	hostModelCatalog?: unknown;
	onProgress?: (event: WorkflowEvent) => void;
	supportsIsolation?: (
		isolation: WorkflowIsolation,
	) => Promise<boolean> | boolean;
	currentIntegrationHead?: () =>
		| Promise<string | undefined>
		| string
		| undefined;
	validateIntegrationHead?: (head: string) => Promise<boolean> | boolean;
	applyPatch?: (
		patch: unknown,
		metadata?: unknown,
	) => Promise<unknown> | unknown;
	captureChanges?: (metadata?: unknown) => Promise<unknown> | unknown;
}

const defaultAgent: AgentDefinition = {
	name: "workflow",
	description: "Workflow subagent",
	systemPrompt: "Complete the assignment and return a structured result.",
	source: "project",
};
type Terminal = "running" | "completed" | "failed" | "cancelled" | "unknown";
const objectValue = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
const stringValue = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;
const booleanValue = (value: unknown): boolean | undefined =>
	typeof value === "boolean" ? value : undefined;
const childKey = (request: AgentRequest): string =>
	request.childId || `${request.runId}:${request.callIndex}`;
function usage(result: SingleResult): AgentResult["usage"] {
	const u = objectValue(result.usage);
	if (!u) return undefined;
	const number = (name: string): number | undefined =>
		typeof u[name] === "number" ? (u[name] as number) : undefined;
	return {
		inputTokens: number("inputTokens"),
		outputTokens: number("outputTokens"),
		totalTokens: number("totalTokens"),
	};
}
function value(result: SingleResult): unknown {
	const structured = objectValue(result.structuredOutput);
	if (!structured) return result.output;
	if ("data" in structured) return structured.data;
	if ("value" in structured) return structured.value;
	return result.output;
}

export function createWorkflowHost(deps: SubprocessRunnerDeps): WorkflowHost {
	const listeners = new Set<(event: WorkflowEvent) => void>();
	const active = new Map<string, AbortController>();
	const pending = new Map<string, Promise<unknown>>();
	const terminals = new Map<string, Terminal>();

	const emit = (event: WorkflowEvent): void => {
		deps.onProgress?.(event);
		for (const listener of listeners) listener(event);
	};

	const invokeAgent = async <T>(
		request: AgentRequest,
		signal: AbortSignal,
	): Promise<AgentResult<T>> => {
		const id = childKey(request);
		if (signal.aborted) {
			terminals.set(id, "cancelled");
			throw new DOMException("Aborted", "AbortError");
		}

		const controller = new AbortController();
		const abort = (): void => controller.abort(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		active.set(id, controller);
		terminals.set(id, "running");

		const options = request.options ?? {};
		const rawToolset = options.toolset ?? deps.toolset;
		const toolNames =
			typeof rawToolset === "string"
				? (BUILTIN_TOOLSETS[rawToolset]?.slice() ?? [rawToolset])
				: Array.isArray(rawToolset)
					? rawToolset.flatMap((entry) =>
							typeof entry === "string"
								? (BUILTIN_TOOLSETS[entry]?.slice() ?? [entry])
								: [],
						)
					: undefined;
		const baseAgent = deps.resolveAgent?.(options.agent) ?? defaultAgent;
		const agent = toolNames ? { ...baseAgent, tools: toolNames } : baseAgent;
		const isolation = objectValue(options.isolation);
		const isolationMode = stringValue(isolation?.mode);
		let worktree =
			stringValue(options.worktree) ?? stringValue(isolation?.worktree);
		let ownedWorktree: string | undefined;
		if (isolationMode && isolationMode !== "none" && !worktree) {
			try {
				await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: deps.cwd });
				const parent = await mkdtemp(join(tmpdir(), "omp-worktree-"));
				await rm(parent, { recursive: true, force: true });
				await exec("git", ["worktree", "add", "--detach", parent, "HEAD"], {
					cwd: deps.cwd,
				});
				worktree = parent;
				ownedWorktree = parent;
			} catch (error) {
				throw new Error("Requested isolation cannot be fulfilled", {
					cause: error,
				});
			}
		}
		const artifactPolicy = objectValue(options.artifactPolicy);
		const artifactsDir =
			stringValue(options.artifactsDir) ??
			stringValue(artifactPolicy?.directory);
		const schemaMode =
			stringValue(options.schemaMode) === "permissive"
				? "permissive"
				: options.schema
					? "strict"
					: undefined;

		const requestedModels = options.fallbacks?.length
			? [options.model, ...options.fallbacks].filter(
					(model): model is string => typeof model === "string",
				)
			: options.model;
		const mappedModels = Array.isArray(requestedModels)
			? requestedModels.map((model) => MODEL_ALIASES[model] ?? model)
			: typeof requestedModels === "string"
				? (MODEL_ALIASES[requestedModels] ?? requestedModels)
				: requestedModels;

		const mapped: SubprocessOptions = {
			cwd: deps.cwd,
			agent,
			task: request.prompt,
			id,
			index: request.callIndex,
			modelOverride: mappedModels,
			effort: (EFFORT_ALIASES[stringValue(options.effort) ?? ""] ??
				stringValue(options.effort)) as SubprocessOptions["effort"],
			outputSchema: options.schema,
			outputSchemaMode: schemaMode as SubprocessOptions["outputSchemaMode"],
			outputSchemaSource: options.schema ? "caller" : undefined,
			outputSchemaOverridesAgent: options.schema !== undefined,
			signal: controller.signal,
			worktree,
			detached:
				booleanValue(options.detached) ?? booleanValue(options.background),
			restrictToolNames: toolNames !== undefined,
			enableMCP: toolNames === undefined,
			persistArtifacts:
				booleanValue(options.persistArtifacts) ?? Boolean(artifactsDir),
			artifactsDir,
			parentArtifactManager: deps.artifacts,
			modelRegistry: deps.modelRegistry,
			settings: deps.settings,
			maxRuntimeMs:
				typeof options.timeoutMs === "number" ? options.timeoutMs : undefined,
			onProgress: (progress: AgentProgress) =>
				emit({
					type: "progress",
					runId: request.runId,
					callIndex: request.callIndex,
					childId: id,
					data: progress,
					at: Date.now(),
				}),
		};

		emit({
			type: "started",
			runId: request.runId,
			callIndex: request.callIndex,
			childId: id,
			data: {
				requestedModel: options.model,
				requestedEffort: options.effort,
				toolset: toolNames,
			},
			at: Date.now(),
		});

		let terminalEmitted = false;
		const operation = (async (): Promise<AgentResult<T>> => {
			try {
				const result = await (deps.subprocess ?? runSubprocess)(mapped);
				const resultObject = result as SingleResult;
				if (controller.signal.aborted || signal.aborted || result.aborted) {
					throw new DOMException("Aborted", "AbortError");
				}
				if (result.exitCode !== 0) {
					throw new Error(
						result.stderr ||
							`Workflow child exited with code ${result.exitCode}`,
					);
				}
				let capturedPatch = result.patchPath;
				let capturedBase = result.branchBaseSha;
				let integration:
					| { branchName: string; integrationHead: string }
					| undefined;
				if (isolationMode && isolationMode !== "none" && worktree) {
					const dir =
						artifactsDir ?? join(deps.cwd, ".omp", "artifacts", request.runId);
					const captured =
						deps.captureChanges !== undefined
							? await deps.captureChanges({
									cwd: worktree,
									artifactDir: dir,
									childId: id,
								})
							: capturedPatch && capturedBase
								? undefined
								: await captureGitChanges(worktree, dir, id);
					const captureObject = objectValue(captured);
					capturedPatch =
						stringValue(captureObject?.patchPath) ??
						(typeof captured === "string" ? captured : capturedPatch);
					capturedBase = stringValue(captureObject?.baseHead) ?? capturedBase;
					const patchPath = capturedPatch;
					const baseHead = capturedBase;
					if (options.apply && patchPath && baseHead) {
						if (controller.signal.aborted || signal.aborted)
							throw new DOMException("Aborted", "AbortError");
						integration = await withIntegration(request.runId, async () => {
							const current = deps.currentIntegrationHead
								? await deps.currentIntegrationHead()
								: await exec("git", ["rev-parse", "HEAD"], {
										cwd: deps.cwd,
									}).then((r) => String(r.stdout).trim());
							if (current !== baseHead)
								throw new Error(
									`Stale integration head: expected ${baseHead}, found ${current}`,
								);
							if (deps.applyPatch) {
								const applied = await deps.applyPatch(patchPath, {
									runId: request.runId,
									childId: id,
									baseHead,
									artifactDir: dir,
									cwd: deps.cwd,
								});
								return objectValue(applied) as {
									branchName: string;
									integrationHead: string;
								};
							}
							return applyGitPatch(
								deps.cwd,
								dir,
								request.runId,
								patchPath,
								baseHead,
							);
						});
					}
				}
				const metadata = objectValue(result);
				const normalized: AgentResult<T> = {
					value: value(resultObject) as T,
					usage: usage(resultObject),
					childId: id,
					sessionId: stringValue(metadata?.sessionId) ?? id,
					handle: stringValue(metadata?.handle) ?? id,
					requestedModel: options.model,
					resolvedModel: result.resolvedModel,
					requestedEffort: options.effort,
					resolvedEffort: stringValue(metadata?.resolvedEffort),
					artifacts: {
						output: result.outputPath,
						patch: capturedPatch,
					},
					patch: capturedPatch,
					branch: integration?.branchName ?? result.branchName,
					integrationHead: integration?.integrationHead ?? capturedBase,
					warnings: result.stderr ? [result.stderr] : undefined,
				};

				if (controller.signal.aborted || signal.aborted || result.aborted) {
					throw new DOMException("Aborted", "AbortError");
				}
				if (result.exitCode !== 0) {
					terminals.set(id, "failed");
					terminalEmitted = true;
					emit({
						type: "failed",
						runId: request.runId,
						callIndex: request.callIndex,
						childId: id,
						data: normalized,
						at: Date.now(),
					});
					throw new Error(
						result.stderr ||
							`Workflow child exited with code ${result.exitCode}`,
						{ cause: normalized },
					);
				}

				terminals.set(id, "completed");
				terminalEmitted = true;
				emit({
					type: "completed",
					runId: request.runId,
					callIndex: request.callIndex,
					childId: id,
					data: normalized,
					at: Date.now(),
				});
				return normalized;
			} catch (error) {
				const cancelled =
					controller.signal.aborted ||
					signal.aborted ||
					(error instanceof DOMException && error.name === "AbortError");
				terminals.set(id, cancelled ? "cancelled" : "failed");
				if (!terminalEmitted) {
					emit({
						type: cancelled ? "cancelled" : "failed",
						runId: request.runId,
						callIndex: request.callIndex,
						childId: id,
						data: {
							error: error instanceof Error ? error.message : String(error),
						},
						at: Date.now(),
					});
				}
				if (cancelled) throw new DOMException("Aborted", "AbortError");
				throw error;
			} finally {
				if (ownedWorktree) {
					await exec("git", ["worktree", "remove", "--force", ownedWorktree], {
						cwd: deps.cwd,
					}).catch(() => undefined);
					await rm(ownedWorktree, { recursive: true, force: true }).catch(
						() => undefined,
					);
				}
				signal.removeEventListener("abort", abort);
				active.delete(id);
				pending.delete(id);
			}
		})();
		pending.set(id, operation);
		return operation;
	};

	const host: WorkflowHost = {
		invokeAgent,
		toolset: (name) =>
			BUILTIN_TOOLSETS[name]
				? { tools: [...BUILTIN_TOOLSETS[name]] }
				: undefined,
		cancel: async (id) => {
			const controller = active.get(id);
			if (!controller) return;
			controller.abort(new DOMException("Aborted", "AbortError"));
			const operation = pending.get(id);
			if (operation) await operation.catch(() => undefined);
		},
		inspectAgent: async (id) => {
			const status = terminals.get(id);
			return status === "running" ||
				status === "completed" ||
				status === "failed" ||
				status === "cancelled" ||
				status === "unknown"
				? status
				: "unknown";
		},
		resolveModel: (name) =>
			name
				? deps.modelRegistry
						?.getAll()
						.find(
							(model) =>
								`${model.provider}/${model.id}` === name || model.id === name,
						)
				: undefined,
		supportsIsolation:
			deps.supportsIsolation ??
			(async (isolation) => {
				if (isolation.mode === "none") return true;
				try {
					await exec("git", ["rev-parse", "--verify", "HEAD"], {
						cwd: deps.cwd,
					});
					return true;
				} catch {
					return false;
				}
			}),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	if (deps.currentIntegrationHead) {
		host.currentIntegrationHead = deps.currentIntegrationHead;
	}
	if (deps.validateIntegrationHead) {
		host.validateIntegrationHead = deps.validateIntegrationHead;
	}
	if (deps.applyPatch) host.applyPatch = deps.applyPatch;
	if (deps.captureChanges) host.captureChanges = deps.captureChanges;
	return host;
}
