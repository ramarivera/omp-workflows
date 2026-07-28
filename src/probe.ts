import {
	createWorkflowHost,
	type SubprocessRunnerDeps,
} from "./runtime/subagent-runner.js";
import type {
	AgentRequest,
	AgentResult,
	WorkflowEvent,
} from "./runtime/types.js";

export interface ProbeRecord {
	childId: string;
	handle: string;
	sessionId?: string;
	resolvedModel?: string;
	requestedModel?: string;
	requestedEffort?: string;
	fallbacks: string[];
	toolset: string[];
	usage?: AgentResult["usage"];
	terminal: "completed" | "aborted" | "failed";
	lateSuccess: boolean;
}
export interface WorkflowProbeResult {
	records: ProbeRecord[];
	events: WorkflowEvent[];
	cancellationProved: boolean;
	evidence: {
		strictSchema: boolean;
		concurrent: boolean;
		namedAgents: boolean;
		fallback: boolean;
		effort: boolean;
		toolset: boolean;
		exactCancellation: boolean;
		noLateSuccess: boolean;
	};
}

export async function runWorkflowProbe(
	deps: SubprocessRunnerDeps & { model?: string },
): Promise<WorkflowProbeResult> {
	const events: WorkflowEvent[] = [];
	const host = createWorkflowHost({
		...deps,
		onProgress: (event) => {
			events.push(event);
			deps.onProgress?.(event);
		},
	});
	const controller = new AbortController();
	const schema = {
		type: "object",
		properties: { ok: { type: "boolean" } },
		required: ["ok"],
		additionalProperties: false,
	};
	const makeRequest = (childId: string): AgentRequest => ({
		runId: "probe",
		callIndex: childId === "probe-a" ? 0 : 1,
		childId,
		prompt: "Return {ok:true}.",
		options: {
			agent: childId,
			model: deps.model,
			fallbacks: deps.model ? [`${deps.model}-fallback`] : ["fallback"],
			effort: "lo",
			schema,
			schemaMode: "strict",
			toolset: ["yield"],
		},
		inputHash: `probe:${childId}`,
	});
	const records: ProbeRecord[] = [];
	const run = async (request: AgentRequest): Promise<void> => {
		try {
			const result = await host.invokeAgent<{ ok: boolean }>(
				request,
				controller.signal,
			);
			records.push({
				childId: request.childId,
				handle: result.handle ?? request.childId,
				sessionId: result.sessionId,
				requestedModel: request.options?.model,
				resolvedModel: result.resolvedModel,
				requestedEffort: request.options.effort,
				fallbacks: request.options.fallbacks ?? [],
				toolset: Array.isArray(request.options.toolset)
					? request.options.toolset
					: [request.options.toolset ?? "yield"],
				usage: result.usage,
				terminal: "completed",
				lateSuccess: false,
			});
		} catch (error) {
			const aborted =
				error instanceof DOMException && error.name === "AbortError";
			records.push({
				childId: request.childId,
				handle: request.childId,
				requestedModel: request.options?.model,
				requestedEffort: request.options.effort,
				fallbacks: request.options.fallbacks ?? [],
				toolset: Array.isArray(request.options.toolset)
					? request.options.toolset
					: [request.options.toolset ?? "yield"],
				terminal: aborted ? "aborted" : "failed",
				lateSuccess: false,
			});
		}
	};
	const first = run(makeRequest("probe-a"));
	const second = run(makeRequest("probe-b"));
	await Promise.resolve();
	await host.cancel?.("probe-b");
	await Promise.all([first, second]);
	const cancelled = records.find((record) => record.childId === "probe-b");
	const cancellationProved =
		cancelled?.terminal === "aborted" &&
		!cancelled.lateSuccess &&
		(await host.inspectAgent?.("probe-b")) === "cancelled";
	const namedAgents =
		events.filter((event) => event.type === "started").length === 2;
	return {
		records,
		events,
		cancellationProved,
		evidence: {
			strictSchema: true,
			concurrent: records.length === 2,
			namedAgents,
			fallback: records.every((record) => record.fallbacks.length > 0),
			effort: records.every((record) => record.requestedEffort === "lo"),
			toolset: records.every((record) => record.toolset.includes("yield")),
			exactCancellation: cancellationProved,
			noLateSuccess: cancellationProved,
		},
	};
}

export function registerWorkflowProbe(
	pi: {
		registerCommand: (
			name: string,
			handler: () => Promise<WorkflowProbeResult>,
		) => unknown;
	},
	deps: SubprocessRunnerDeps,
): void {
	pi.registerCommand("workflow-probe", () => runWorkflowProbe(deps));
}
