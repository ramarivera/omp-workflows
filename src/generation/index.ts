import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "acorn";
import { simple } from "acorn-walk";
export interface WorkflowGenerator {
	generate(request: string, guidance: string): Promise<string>;
}
export interface StagedSource {
	path: string;
	source: string;
}
const GUIDANCE =
	"Generate inspectable TypeScript using defineWorkflow from @ramarivera/omp-workflows. Use deterministic agent/parallel/pipeline/phase composition, explicit JSON schemas, and no host capabilities, imports, dynamic execution, networking, filesystem, timers, randomness, or environment access. Generation never executes workflow code; output requires explicit approval.";
const FORBIDDEN_IDENTIFIERS: Record<string, true> = {
	require: true,
	fetch: true,
	WebSocket: true,
	eval: true,
	Function: true,
	fs: true,
	net: true,
	http: true,
	https: true,
	child_process: true,
	crypto: true,
};
const FORBIDDEN_HOSTS: Record<string, true> = {
	process: true,
	globalThis: true,
	Deno: true,
	Bun: true,
};
export function validateSourcePolicy(source: string): void {
	let tree: ReturnType<typeof parse>;
	try {
		tree = parse(source, {
			ecmaVersion: "latest",
			sourceType: "module",
		});
	} catch {
		const javascript =
			typeof Bun === "undefined"
				? source
				: new Bun.Transpiler({ loader: "ts" }).transformSync(source);
		tree = parse(javascript, {
			ecmaVersion: "latest",
			sourceType: "module",
		});
	}
	if (!("body" in tree) || !Array.isArray(tree.body)) {
		throw new Error("Workflow source must be an ECMAScript module");
	}
	let violation = false;
	for (const node of tree.body) {
		if (
			node.type === "ImportDeclaration" &&
			node.source.value !== "@ramarivera/omp-workflows"
		) {
			violation = true;
		}
		if (
			node.type === "ExportAllDeclaration" ||
			(node.type === "ExportNamedDeclaration" && node.source)
		) {
			violation = true;
		}
	}
	simple(tree, {
		ImportExpression: () => {
			violation = true;
		},
		Identifier: (node: unknown) => {
			const name = String((node as Record<string, unknown>).name);
			if (FORBIDDEN_IDENTIFIERS[name]) violation = true;
		},
		MemberExpression: (node: unknown) => {
			const member = node as Record<string, unknown>;
			const object = member.object as Record<string, unknown>;
			const property = member.property as Record<string, unknown>;
			const objectName = String(object?.name);
			const propertyName = String(property?.name ?? property?.value);
			if (
				FORBIDDEN_HOSTS[objectName] ||
				(objectName === "Math" && propertyName === "random") ||
				(objectName === "Date" && propertyName === "now") ||
				(objectName === "performance" && propertyName === "now") ||
				(objectName === "crypto" && propertyName.startsWith("random"))
			) {
				violation = true;
			}
		},
		NewExpression: (node: unknown) => {
			const callee = (node as Record<string, unknown>).callee as Record<
				string,
				unknown
			>;
			if (["Date", "WebSocket", "Function"].includes(String(callee?.name))) {
				violation = true;
			}
		},
	});
	if (violation)
		throw new Error(
			"Forbidden import, host capability, or nondeterministic operation",
		);
}
export async function generateStaged(
	request: string,
	generator: WorkflowGenerator,
	stagingDir: string,
): Promise<StagedSource> {
	const source = await generator.generate(request, GUIDANCE);
	if (!source.trim()) throw new Error("Generator returned empty source");
	validateSourcePolicy(source);
	await mkdir(stagingDir, { recursive: true });
	const path = join(stagingDir, `workflow-${randomUUID()}.ts`);
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, source, { encoding: "utf8", flag: "wx" });
	await rename(temporary, path);
	return { path, source };
}
export const authoringGuidance = GUIDANCE;
