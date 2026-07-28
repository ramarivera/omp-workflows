export type WorkflowRunStatus =
	| "planned"
	| "awaiting_approval"
	| "running"
	| "pausing"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled"
	| "persistence_degraded";
export type WorkflowAttemptStatus =
	| "queued"
	| "dispatched"
	| "running"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "unknown";
export type WorkflowCallStatus =
	| "queued"
	| "dispatched"
	| "running"
	| "cached"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "unknown";
export type PersistenceHealth = "healthy" | "degraded";

export interface WorkflowLimits {
	maxConcurrency?: number;
	maxAgents?: number;
	maxOutputTokens?: number;
	maxRuntimeMs?: number;
	maxIdleMs?: number;
	maxNoProgressMs?: number;
}

export interface WorkflowIsolation {
	mode: "none" | "required" | "worktree";
}

export interface AgentCallOptions {
	id?: string;
	model?: string;
	agent?: string;
	effort?: string;
	fallbacks?: string[];
	schema?: unknown;
	schemaMode?: "strict" | "permissive";
	toolset?: string | string[];
	isolation?: WorkflowIsolation;
	apply?: boolean;
	worktree?: string;
	timeoutMs?: number;
	idleTimeoutMs?: number;
	input?: unknown;
	[key: string]: unknown;
}

export interface AgentRequest {
	runId: string;
	callIndex: number;
	childId: string;
	prompt: string;
	options: AgentCallOptions;
	inputHash: string;
	signal?: AbortSignal;
}

export interface AgentUsage {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

export interface AgentResult<T = unknown> {
	value: T;
	usage?: AgentUsage;
	childId?: string;
	sessionId?: string;
	handle?: string;
	requestedModel?: string;
	resolvedModel?: string;
	requestedEffort?: string;
	resolvedEffort?: string;
	artifacts?: unknown;
	patch?: unknown;
	branch?: unknown;
	integrationHead?: string;
	warnings?: string[];
}

export type AgentRuntimeState =
	| "running"
	| "completed"
	| "failed"
	| "cancelled"
	| "unknown";

export interface WorkflowHost {
	invokeAgent<T = unknown>(
		request: AgentRequest,
		signal: AbortSignal,
	): Promise<AgentResult<T>>;
	cancel?(childId: string): Promise<void> | void;
	inspectAgent?(childId: string): Promise<AgentRuntimeState>;
	resolveModel?(name?: string): unknown;
	currentIntegrationHead?(): Promise<string | undefined> | string | undefined;
	validateIntegrationHead?(head: string): Promise<boolean> | boolean;
	supportsIsolation?(isolation: WorkflowIsolation): Promise<boolean> | boolean;
	applyPatch?(patch: unknown, metadata?: unknown): Promise<unknown> | unknown;
	captureChanges?(metadata?: unknown): Promise<unknown> | unknown;
	hostModelCatalog?: unknown;
	toolset?(name: string): unknown;
	subscribe?(listener: (event: WorkflowEvent) => void): () => void;
}

export interface WorkflowDefinition<A = unknown, R = unknown> {
	name: string;
	version: number;
	sourceHash?: string;
	sourcePath?: string;
	args?: unknown;
	limits?: WorkflowLimits;
	run(ctx: WorkflowContext<A>): Promise<R> | R;
}

export interface WorkflowAttempt {
	id: string;
	callIndex: number;
	childId: string;
	status: WorkflowAttemptStatus;
	inputHash: string;
	startedAt?: number;
	finishedAt?: number;
	result?: unknown;
	error?: string;
	usage?: AgentUsage;
	sessionId?: string;
	handle?: string;
	requestedModel?: string;
	resolvedModel?: string;
	requestedEffort?: string;
	resolvedEffort?: string;
	artifacts?: unknown;
	patch?: unknown;
	branch?: unknown;
	integrationHead?: string;
	warnings?: string[];
}

export interface WorkflowCall {
	index: number;
	namespace: string;
	inputHash: string;
	status: WorkflowCallStatus;
	attempts: WorkflowAttempt[];
	result?: unknown;
	label?: string;
}

export interface DeterministicState {
	now: number[];
	random: number[];
}

export interface WorkflowRun<A = unknown> {
	schemaVersion: 2;
	id: string;
	namespace: string;
	controllerGeneration: number;
	fencingToken: string;
	executionEpoch?: number;
	journalSeq?: number;
	definition: {
		name: string;
		version: number;
		sourceHash?: string;
		sourcePath?: string;
	};
	args: A;
	approval?: {
		hash: string;
		tuple: unknown;
	};
	limits: WorkflowLimits;
	status: WorkflowRunStatus;
	persistenceHealth: PersistenceHealth;
	calls: WorkflowCall[];
	deterministic?: DeterministicState;
	totals: {
		agents: number;
		outputTokens: number;
		runtimeMs: number;
	};
	phases: string[];
	createdAt: number;
	updatedAt: number;
	result?: unknown;
	error?: string;
	blockedReason?: string;
}

export interface JournalEvent {
	schemaVersion: 2;
	seq: number;
	type: string;
	runId: string;
	callIndex?: number;
	attemptId?: string;
	payload?: unknown;
	at: number;
}

export interface WorkflowContext<A = unknown> {
	args: A;
	agent<T = unknown>(prompt: string, options?: AgentCallOptions): Promise<T>;
	parallel<T>(tasks: Array<() => Promise<T>>, fatal?: boolean): Promise<T[]>;
	pipeline<T>(
		value: T | Promise<T>,
		...stages: Array<(value: unknown) => T | Promise<T>>
	): Promise<T>;
	phase(title: string): void;
	now(): number;
	random(): number;
}

export interface WorkflowEvent {
	type: string;
	runId: string;
	callIndex?: number;
	childId?: string;
	data?: unknown;
	at: number;
}
