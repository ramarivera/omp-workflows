import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "acorn";
import type { WorkflowDefinition } from "../runtime/types.js";
import type {
	DiscoveredWorkflow,
	DiscoveryDiagnostic,
	WorkflowDiscoveryList,
	WorkflowDiscoveryOptions,
	WorkflowScope,
	WorkflowSource,
} from "./types.js";

const EXT = /\.(?:ts|tsx|js|mjs|mts)$/;
type Node = Record<string, unknown>;
function literal(value: unknown): unknown {
	if (!value || typeof value !== "object") return undefined;
	const node = value as Node;
	if (node.type === "Literal") return node.value;
	if (
		node.type === "UnaryExpression" &&
		node.operator === "-" &&
		typeof node.argument === "object"
	) {
		const n = literal(node.argument);
		return typeof n === "number" ? -n : undefined;
	}
	if (node.type === "ArrayExpression" && Array.isArray(node.elements))
		return node.elements.map(literal);
	if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
		const out: Record<string, unknown> = {};
		for (const raw of node.properties) {
			const p = raw as Node;
			if (p.type !== "Property" || p.computed || p.kind !== "init")
				return undefined;
			const keyNode = p.key as Node;
			const key = keyNode?.name ?? keyNode?.value;
			if (typeof key !== "string") return undefined;
			if (key === "run") continue;
			const v = literal(p.value);
			if (v === undefined && (p.value as Node)?.type !== "Identifier")
				return undefined;
			out[key] = v;
		}
		return out;
	}
	return undefined;
}
function staticDefinition(
	source: string,
	path: string,
): WorkflowDefinition | undefined {
	let js = source;
	if (/\.(?:ts|tsx|mts)$/.test(path) && typeof Bun !== "undefined")
		js = new Bun.Transpiler({ loader: "tsx" }).transformSync(source);
	const tree = parse(js, {
		ecmaVersion: "latest",
		sourceType: "module",
	}) as unknown as Node;
	for (const raw of (tree.body as unknown[]) ?? []) {
		const s = raw as Node;
		if (s.type !== "ExportNamedDeclaration") continue;
		const d = s.declaration as Node | undefined;
		if (d?.type !== "VariableDeclaration") continue;
		for (const item of (d.declarations as unknown[]) ?? []) {
			const decl = item as Node;
			if ((decl.id as Node)?.name !== "workflow") continue;
			const init = decl.init as Node | undefined;
			if (
				init?.type !== "CallExpression" ||
				(init.callee as Node)?.name !== "defineWorkflow"
			)
				continue;
			const record = literal(((init.arguments as unknown[]) ?? [])[0]);
			if (!record || typeof record !== "object") return undefined;
			const metadata = record as Record<string, unknown>;
			if (
				typeof metadata.name !== "string" ||
				typeof metadata.version !== "number"
			)
				return undefined;
			return {
				name: metadata.name,
				version: metadata.version,
				args: metadata.args,
				limits: metadata.limits as WorkflowDefinition["limits"],
				run: () => {
					throw new Error("Static discovery definition cannot execute");
				},
			};
		}
	}
	return undefined;
}
async function scan(
	dir: string,
	scope: WorkflowScope,
	plugin: string | undefined,
	diagnostics: DiscoveryDiagnostic[],
): Promise<DiscoveredWorkflow[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		diagnostics.push({
			path: dir,
			scope,
			message: error instanceof Error ? error.message : "Unreadable directory",
		});
		return [];
	}

	const out: DiscoveredWorkflow[] = [];
	for (const entry of entries
		.filter((candidate) => EXT.test(candidate.name))
		.sort((left, right) => left.name.localeCompare(right.name))) {
		const sourcePath = join(dir, entry.name);
		try {
			const stat = await lstat(sourcePath);
			if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
				diagnostics.push({
					path: sourcePath,
					scope,
					message: "Symlink sources are not allowed",
				});
				continue;
			}
			if (!stat.isFile()) continue;
			const source = await readFile(sourcePath, "utf8");
			const definition = staticDefinition(source, sourcePath);
			if (definition) {
				out.push({
					definition,
					source: { path: sourcePath, scope, plugin },
				});
			} else {
				diagnostics.push({
					path: sourcePath,
					scope,
					message: "No statically discoverable workflow metadata",
				});
			}
		} catch (error) {
			diagnostics.push({
				path: sourcePath,
				scope,
				message: error instanceof Error ? error.message : "Invalid source",
			});
		}
	}
	return out;
}
export async function discoverWorkflowFile(
	filePath: string,
	sourceOrScope: WorkflowScope | WorkflowSource,
	plugin?: string,
): Promise<DiscoveredWorkflow | undefined> {
	const scope =
		typeof sourceOrScope === "string" ? sourceOrScope : sourceOrScope.scope;
	const pluginRoot =
		typeof sourceOrScope === "string" ? plugin : sourceOrScope.plugin;
	const parent = dirname(filePath);
	const diagnostics: DiscoveryDiagnostic[] = [];
	const found = await scan(parent, scope, pluginRoot, diagnostics);
	return found.find((item) => item.source.path === filePath);
}
export async function discoverWorkflows(
	options: WorkflowDiscoveryOptions,
): Promise<WorkflowDiscoveryList> {
	const diagnostics: DiscoveryDiagnostic[] = [];
	const project = await scan(
		join(options.projectDir, ".omp/workflows"),
		"project",
		undefined,
		diagnostics,
	);
	const user = await scan(
		options.userDir ?? join(process.env.HOME ?? "", ".omp/workflows"),
		"user",
		undefined,
		diagnostics,
	);
	const plugins = (
		await Promise.all(
			(options.pluginDirs ?? [])
				.slice()
				.sort()
				.map((directory) =>
					scan(join(directory, "workflows"), "plugin", directory, diagnostics),
				),
		)
	).flat();

	const selected = new Map<string, DiscoveredWorkflow>();
	for (const item of [...project, ...user, ...plugins]) {
		if (selected.has(item.definition.name)) {
			diagnostics.push({
				path: item.source.path,
				scope: item.source.scope,
				message: `Collision for ${item.definition.name}; higher-precedence definition selected`,
			});
		} else {
			selected.set(item.definition.name, item);
		}
	}
	const workflows = [...selected.values()].sort((left, right) =>
		left.definition.name.localeCompare(right.definition.name),
	);
	diagnostics.sort((left, right) =>
		`${left.scope}:${left.path}:${left.message}`.localeCompare(
			`${right.scope}:${right.path}:${right.message}`,
		),
	);
	return Object.assign(workflows, { diagnostics });
}
export async function readWorkflowSource(
	source: DiscoveredWorkflow,
): Promise<string> {
	return readFile(source.source.path, "utf8");
}
