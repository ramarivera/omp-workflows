import type { WorkflowRun } from "../runtime/types.js";
export function inspectWorkflow(run: WorkflowRun): Record<string, unknown> {
	const recent = (run.calls ?? []).slice(-10).map((call) => ({
		index: call.index,
		phase: call.label ?? call.namespace,
		status: call.status,
		model:
			call.attempts?.at(-1)?.resolvedModel ??
			call.attempts?.at(-1)?.requestedModel,
		result: call.result,
		error: call.attempts?.at(-1)?.error,
		artifacts: call.attempts?.at(-1)?.artifacts,
	}));
	return {
		id: run.id,
		status: run.status,
		phase: run.phases?.at(-1),
		phases: run.phases,
		definition: run.definition,
		args: run.args,
		calls: run.calls,
		recent,
		result: run.result,
		error: run.error,
		artifacts: (run as WorkflowRun & { artifacts?: unknown }).artifacts,
		blockedDependencies: run.blockedReason,
		persistenceHealth: run.persistenceHealth,
		limits: run.limits,
		totals: run.totals,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
	};
}
