import path from "node:path";
export function workflowRunsRoot(cwd = process.cwd()): string {
	return path.join(cwd, ".omp", "workflow-runs");
}
export function runPath(runId: string, cwd = process.cwd()): string {
	return path.join(workflowRunsRoot(cwd), runId);
}
export function runJsonPath(runId: string, cwd = process.cwd()): string {
	return path.join(runPath(runId, cwd), "run.json");
}
export function journalPath(runId: string, cwd = process.cwd()): string {
	return path.join(runPath(runId, cwd), "journal.jsonl");
}
export function backupPath(runId: string, cwd = process.cwd()): string {
	return path.join(runPath(runId, cwd), "run.json.bak");
}
export function workflowApprovalPath(
	scope: "project" | "user",
	cwd = process.cwd(),
): string {
	return scope === "project"
		? path.join(cwd, ".omp", "workflow-approvals.json")
		: path.join(process.env.HOME ?? cwd, ".omp", "workflow-approvals.json");
}
export function workflowStagingRoot(cwd = process.cwd()): string {
	return path.join(cwd, ".omp", "workflows", ".staging");
}
export function workflowScopePath(
	scope: "project" | "user" | "plugin",
	cwd = process.cwd(),
	plugin?: string,
): string {
	if (scope === "plugin") return path.join(plugin ?? cwd, "workflows");
	if (scope === "project") return path.join(cwd, ".omp", "workflows");
	return path.join(process.env.HOME ?? cwd, ".omp", "workflows");
}
export function workflowSourcePath(
	scope: "project" | "user" | "plugin",
	name: string,
	cwd = process.cwd(),
	plugin?: string,
): string {
	return path.join(workflowScopePath(scope, cwd, plugin), `${name}.ts`);
}
export function outputPath(runId: string, cwd = process.cwd()): string {
	return path.join(runPath(runId, cwd), "output");
}
