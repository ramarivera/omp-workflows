import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateSourcePolicy } from "../generation/index.js";
import type { WorkflowDefinition } from "../runtime/types.js";
import { workflowHash } from "../ui/approval.js";
import type { WorkflowApprovalRecord } from "./types.js";
import { assertValidDefinition } from "./validation.js";

const PUBLIC_RUNTIME_URL = new URL("./index.js", import.meta.url).href;

async function importApprovedModule(
	path: string,
	source: string,
	sourceHash: string,
): Promise<Record<string, unknown>> {
	if (typeof Bun === "undefined") {
		return import(`${pathToFileURL(path).href}?approved=${sourceHash}`);
	}
	const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
	const rewritten = javascript
		.replace(
			/(\bfrom\s*)(["'])@ramarivera\/omp-workflows\2/g,
			`$1${JSON.stringify(PUBLIC_RUNTIME_URL)}`,
		)
		.replace(
			/(\bimport\s*)(["'])@ramarivera\/omp-workflows\2/g,
			`$1${JSON.stringify(PUBLIC_RUNTIME_URL)}`,
		);
	if (rewritten === javascript) {
		throw new Error("Workflow source must import the public workflow runtime");
	}
	const runtimeDir = await mkdtemp(
		join(dirname(path), ".omp-workflow-runtime-"),
	);
	const runtimePath = join(runtimeDir, `${sourceHash}.mjs`);
	const sourceUrl = `${pathToFileURL(path).href}?approved=${sourceHash}`;
	await writeFile(runtimePath, `${rewritten}\n//# sourceURL=${sourceUrl}`, {
		mode: 0o600,
	});
	try {
		// Runtime-selected, approved workflow modules cannot use a static import.
		return await import(
			`${pathToFileURL(runtimePath).href}?approved=${sourceHash}`
		);
	} finally {
		await rm(runtimeDir, { recursive: true, force: true });
	}
}

export async function loadApprovedWorkflow(
	path: string,
	approval: WorkflowApprovalRecord,
): Promise<WorkflowDefinition> {
	if (
		!approval ||
		approval.sourcePath !== path ||
		!/^[0-9a-f]{64}$/.test(approval.hash)
	) {
		throw new Error("Complete approval record is required");
	}
	const stat = await lstat(path);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error("Workflow source must be a regular file");
	}
	const source = await readFile(path, "utf8");
	validateSourcePolicy(source);
	if (!approval.tuple || typeof approval.tuple !== "object") {
		throw new Error("Malformed approval tuple");
	}
	const tupleRecord = approval.tuple as Record<string, unknown>;
	const tupleSource = tupleRecord.source;
	if (!tupleSource || typeof tupleSource !== "object") {
		throw new Error("Approval source tuple is missing");
	}
	const sourceRecord = tupleSource as Record<string, unknown>;
	if (
		sourceRecord.path !== path ||
		!["project", "user", "plugin"].includes(String(sourceRecord.scope)) ||
		!["project", "user"].includes(approval.scope)
	) {
		throw new Error("Approval source tuple mismatch");
	}
	const sourceHash = createHash("sha256").update(source).digest("hex");
	const approvedTuple = { ...tupleRecord };
	delete approvedTuple.hash;
	if (workflowHash(source, approvedTuple) !== approval.hash) {
		throw new Error("Workflow source or approval tuple is not approved");
	}
	// OMP's packaged Bun runtime cannot resolve an external workflow's bare
	// package import, so the approved source is rewritten to the same public API.
	const mod = await importApprovedModule(path, source, sourceHash);
	const definition = mod.workflow ?? mod.default;
	if (!definition || typeof definition !== "object") {
		throw new Error("Invalid workflow definition");
	}
	assertValidDefinition(definition as WorkflowDefinition);
	return {
		...(definition as WorkflowDefinition),
		sourcePath: path,
		sourceHash,
	};
}
