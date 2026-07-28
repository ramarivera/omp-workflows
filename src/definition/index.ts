import type {
	WorkflowContext,
	WorkflowDefinition,
	WorkflowLimits,
} from "../runtime/types.js";

export interface DefinitionInput<A = unknown, R = unknown> {
	name: string;
	version: number;
	args: Record<string, unknown>;
	limits: WorkflowLimits;
	run(context: WorkflowContext<A>): Promise<R> | R;
}
export function defineWorkflow<A = unknown, R = unknown>(
	input: DefinitionInput<A, R>,
): WorkflowDefinition<A, R> {
	if (!input.name || !/^[-a-z0-9]+$/.test(input.name))
		throw new Error("Workflow name must be kebab-case");
	if (!Number.isInteger(input.version) || input.version < 1)
		throw new Error("Workflow version must be positive");
	return Object.freeze({ ...input }) as WorkflowDefinition<A, R>;
}
export type { WorkflowDefinition, WorkflowLimits } from "../runtime/types.js";
export * from "./types.js";
