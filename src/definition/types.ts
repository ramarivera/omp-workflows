import type { WorkflowDefinition, WorkflowLimits } from "../runtime/types.js";

export type WorkflowScope = "project" | "user" | "plugin";
export interface WorkflowSource {
	path: string;
	scope: WorkflowScope;
	plugin?: string;
}
export interface WorkflowDiscoveryOptions {
	projectDir: string;
	userDir?: string;
	pluginDirs?: string[];
}
export interface DiscoveryDiagnostic {
	path: string;
	scope: WorkflowScope;
	message: string;
}
export interface DiscoveredWorkflow {
	definition: WorkflowDefinition;
	source: WorkflowSource;
}
export type WorkflowDiscoveryList = DiscoveredWorkflow[] & {
	readonly diagnostics: DiscoveryDiagnostic[];
};
export interface WorkflowApprovalRecord {
	workflowId: string;
	hash: string;
	approvedAt: string;
	scope: "project" | "user";
	sourcePath: string;
	toolset: string[];
	runtimeVersion: string;
	tuple: unknown;
}
export interface WorkflowApprovalCall {
	id?: string;
	prompt?: string;
	agent?: string;
	model?: string;
	effort?: string;
	fallbacks: string[];
	toolset: string[];
	isolation?: unknown;
	apply?: boolean;
}
export interface WorkflowApprovalPreview {
	rawSource: string;
	args: unknown;
	phases: string[];
	calls: WorkflowApprovalCall[];
	routing: unknown;
	limits: WorkflowLimits;
	filesystem: string[];
	pluginSource?: string;
	hash: string;
	toolset: string[];
	versions: { runtime: string; definition: number };
	workflowId?: string;
	source: WorkflowSource;
	metadata: { name: string; version: number; schema: unknown };
	model?: unknown;
	effort?: unknown;
	isolation?: unknown;
	apply?: unknown;
	fallbacks?: unknown;
}
