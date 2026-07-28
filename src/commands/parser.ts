export type WorkflowScope = "project" | "user" | "plugin";
export const WORKFLOW_COMMANDS = [
	"generate",
	"create",
	"approve",
	"start",
	"run",
	"list",
	"status",
	"inspect",
	"pause",
	"resume",
	"stop",
	"retry",
	"save",
	"revoke",
	"probe",
	"help",
] as const;
export type WorkflowCommand = (typeof WORKFLOW_COMMANDS)[number];
export interface ParsedWorkflowArgs {
	command: WorkflowCommand;
	positionals: string[];
	args?: unknown;
	scope?: WorkflowScope;
}

export function parseWorkflowArgs(input: string): ParsedWorkflowArgs {
	const tokens = tokenize(input.trim());
	const raw = tokens.shift() ?? "help";
	const command = raw === "run" ? "start" : raw;
	if (!(WORKFLOW_COMMANDS as readonly string[]).includes(command))
		throw new Error(`unknown workflow command: ${raw}`);
	const positionals: string[] = [];
	let args: unknown;
	let scope: WorkflowScope | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--args" || token === "--json") {
			const rawJson = tokens[++i];
			if (!rawJson) throw new Error(`${token} requires JSON`);
			try {
				args = JSON.parse(rawJson);
			} catch {
				throw new Error(`${token} must be valid JSON`);
			}
		} else if (token === "--scope") {
			const value = tokens[++i];
			if (value !== "project" && value !== "user" && value !== "plugin")
				throw new Error("--scope must be project, user, or plugin");
			scope = value;
		} else if (token.startsWith("--"))
			throw new Error(`unknown option ${token}`);
		else positionals.push(token);
	}
	return { command: command as WorkflowCommand, positionals, args, scope };
}
function tokenize(value: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote = "";
	let escaped = false;
	for (const ch of value) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = "";
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (/\s/.test(ch)) {
			if (current) {
				out.push(current);
				current = "";
			}
		} else current += ch;
	}
	if (quote) throw new Error("unterminated quote");
	if (escaped) current += "\\";
	if (current) out.push(current);
	return out;
}
