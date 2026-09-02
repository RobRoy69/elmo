import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const packagesRoot = path.join(repoRoot, "packages");
const workspacePackages = new Map();

for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;

	const directory = path.join(packagesRoot, entry.name);
	const manifestPath = path.join(directory, "package.json");
	let manifest;
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") continue;
		throw error;
	}

	if (manifest.name?.startsWith("@workspace/")) {
		workspacePackages.set(manifest.name, { directory, manifest });
	}
}

function resolveExport(specifier) {
	const [scope, packageName, ...subpathParts] = specifier.split("/");
	const name = `${scope}/${packageName}`;
	const workspacePackage = workspacePackages.get(name);
	if (!workspacePackage) {
		throw new Error(`Unknown workspace package: ${name}`);
	}

	const exportKey = subpathParts.length === 0 ? "." : `./${subpathParts.join("/")}`;
	const exports = workspacePackage.manifest.exports;
	let target = typeof exports === "string" && exportKey === "." ? exports : exports?.[exportKey];

	if (!target && exports && typeof exports === "object") {
		for (const [pattern, patternTarget] of Object.entries(exports)) {
			if (!pattern.includes("*") || typeof patternTarget !== "string") continue;
			const [prefix, suffix] = pattern.split("*");
			if (!exportKey.startsWith(prefix) || !exportKey.endsWith(suffix)) continue;
			const matched = exportKey.slice(prefix.length, exportKey.length - suffix.length);
			target = patternTarget.replace("*", matched);
			break;
		}
	}

	if (!target && exportKey === ".") {
		target = workspacePackage.manifest.main;
	}
	if (typeof target !== "string") {
		throw new Error(`No string export ${exportKey} in ${name}`);
	}

	return path.resolve(workspacePackage.directory, target);
}

await build({
	absWorkingDir: repoRoot,
	entryPoints: ["apps/worker/src/index.ts"],
	outfile: "apps/worker/dist-runtime/index.mjs",
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node24",
	packages: "external",
	plugins: [
		{
			name: "bundle-workspace-packages",
			setup(buildContext) {
				buildContext.onResolve({ filter: /^@workspace\// }, ({ path: specifier }) => ({
					path: resolveExport(specifier),
				}));
			},
		},
	],
});
