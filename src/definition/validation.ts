import AjvModule from "ajv";
import type { WorkflowDefinition } from "../runtime/types.js";
export interface ValidationIssue {
	path: string;
	message: string;
}
type Check = ((value: unknown) => boolean) & {
	errors?: Array<{ instancePath?: string; message?: string }>;
};
function validator(schema: unknown): Check {
	const moduleValue = AjvModule as unknown as {
		default?: new (options: {
			allErrors: boolean;
			strict: boolean;
		}) => { compile: (input: unknown) => Check };
	};
	const Constructor =
		moduleValue.default ??
		(AjvModule as unknown as new (options: {
			allErrors: boolean;
			strict: boolean;
		}) => { compile: (input: unknown) => Check });
	return new Constructor({ allErrors: true, strict: true }).compile(schema);
}
export function validateArguments(
	schema: unknown,
	value: unknown,
): ValidationIssue[] {
	if (schema === undefined) return [];
	try {
		const check = validator(schema);
		if (check(value)) return [];
		return (check.errors ?? []).map((error) => ({
			path: error.instancePath || "$",
			message: error.message ?? "Schema validation failed",
		}));
	} catch (error) {
		return [
			{
				path: "$schema",
				message: error instanceof Error ? error.message : "Invalid JSON Schema",
			},
		];
	}
}
export function assertValidArguments(schema: unknown, value: unknown): void {
	const issues = validateArguments(schema, value);
	if (issues.length)
		throw new Error(
			issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
		);
}
export function validateDefinition(
	definition: WorkflowDefinition,
): ValidationIssue[] {
	const issues: ValidationIssue[] = [];
	if (!definition || typeof definition !== "object")
		return [{ path: "definition", message: "Definition must be an object" }];
	if (!definition.name || !/^[-a-z0-9]+$/.test(definition.name))
		issues.push({ path: "name", message: "Must be kebab-case" });
	if (!Number.isInteger(definition.version) || definition.version < 1)
		issues.push({ path: "version", message: "Must be a positive integer" });
	if (typeof definition.run !== "function")
		issues.push({ path: "run", message: "run must be callable" });
	if (definition.limits && typeof definition.limits !== "object")
		issues.push({ path: "limits", message: "Must be an object" });
	return issues;
}
export function assertValidDefinition(definition: WorkflowDefinition): void {
	const issues = validateDefinition(definition);
	if (issues.length)
		throw new Error(
			issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
		);
}
