import { createRequire } from "node:module";

type PackageMetadata = { version?: unknown };

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as PackageMetadata;

if (
	typeof packageMetadata.version !== "string" ||
	packageMetadata.version.length === 0
) {
	throw new Error(
		"omp-workflows package.json must declare a non-empty version",
	);
}

/** The installed package version bound into every approval preview. */
export const PLUGIN_VERSION = packageMetadata.version;
