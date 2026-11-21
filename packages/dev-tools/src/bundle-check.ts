import { cp, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createCatalogWorkerDefinitionResolver,
	loadExtensionCatalog,
} from "@leitwerk-dev/extension-runtime";
import { createAppContext, getDefaultConfig } from "@leitwerk-dev/server";
import type { ExtensionBundleManifest } from "./bundle.js";
import { packageDirectory, readJson } from "./workspace.js";

function packageName(specifier: string): string | null {
	if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:"))
		return null;
	return specifier.startsWith("@")
		? specifier.split("/").slice(0, 2).join("/")
		: specifier.split("/")[0];
}

function importSpecifiers(source: string): string[] {
	const result: string[] = [];
	const patterns = [
		/\b(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns)
		for (const match of source.matchAll(pattern)) result.push(match[1]);
	return result;
}

/** Verify that every bundled JavaScript bare import is provided by the bundle or host. @internal */
export async function checkBundleClosure(
	bundleDir: string,
	manifest: ExtensionBundleManifest,
): Promise<void> {
	const bundled = new Set(manifest.packages.map((entry) => entry.name));
	const hosts = new Set(manifest.hostPackages.map((entry) => entry.name));
	for (const entry of manifest.packages) {
		const root = path.join(bundleDir, entry.path);
		const files = await (await import("node:fs/promises")).readdir(root, {
			recursive: true,
			withFileTypes: true,
		});
		for (const file of files) {
			if (!file.isFile() || !/\.(?:js|mjs|cjs)$/.test(file.name)) continue;
			const source = await readFile(path.join(file.parentPath, file.name), "utf8");
			for (const specifier of importSpecifiers(source)) {
				const name = packageName(specifier);
				if (name && !bundled.has(name) && !hosts.has(name)) {
					throw new Error(`Bundle closure: '${entry.name}' imports undeclared package '${name}'`);
				}
			}
		}
	}
}

async function verifyHosts(manifest: ExtensionBundleManifest): Promise<void> {
	for (const required of manifest.hostPackages) {
		const installedDir = packageDirectory(required.name, process.cwd());
		const installed = readJson<{ version?: string }>(
			path.join(installedDir, "package.json"),
		).version;
		if (installed !== required.version) {
			throw new Error(
				`Host package '${required.name}' version mismatch: bundle requires ${required.version ?? "unknown"}, installed ${installed ?? "unknown"}`,
			);
		}
	}
}

/** Run the built-artifact bundle boot check. @internal */
export async function checkExtensionBundle(bundleDir: string): Promise<void> {
	const manifest = JSON.parse(
		await readFile(path.join(bundleDir, "bundle.json"), "utf8"),
	) as ExtensionBundleManifest;
	await checkBundleClosure(bundleDir, manifest);
	await verifyHosts(manifest);
	const scratch = await mkdtemp(path.join(tmpdir(), "leitwerk-bundle-check-"));
	try {
		// The check is deliberately outside the workspace. Install only declared hosts so
		// a hoisted workspace dependency cannot make an undeclared import pass at runtime.
		const checkedBundle = path.join(scratch, "bundle");
		await cp(bundleDir, checkedBundle, { recursive: true });
		for (const host of manifest.hostPackages) {
			const target = path.join(scratch, "node_modules", host.name);
			await (await import("node:fs/promises")).mkdir(path.dirname(target), { recursive: true });
			await symlink(packageDirectory(host.name, process.cwd()), target);
		}
		const sources = manifest.sources.map((source) =>
			path.join(checkedBundle, "node_modules", source.packageName),
		);
		const config = getDefaultConfig();
		config.storage.sqlite_path = ":memory:";
		config.extension_loading.sources = sources;
		const catalog = await loadExtensionCatalog({ startDir: checkedBundle, sources });
		if (!catalog) throw new Error("Bundle worker catalog was not loaded");
		// Resolve every worker definition through the same catalog the local worker uses;
		// this catches worker-boundary imports rather than merely proving server setup ran.
		const resolveWorker = createCatalogWorkerDefinitionResolver(catalog);
		for (const processId of catalog.processes.keys()) {
			if (!resolveWorker(processId))
				throw new Error(`Bundle worker catalog could not resolve '${processId}'`);
		}
		const context = await createAppContext({
			config,
			extensionCatalog: catalog,
			extensionLoadingStartDir: checkedBundle,
			logger: false,
		});
		try {
			await context.app.listen({ host: "127.0.0.1", port: 0 });
			const health = await context.app.inject({ method: "GET", url: "/api/health" });
			if (health.statusCode !== 200 || health.json().status !== "ok")
				throw new Error(`Bundle boot check failed with HTTP ${health.statusCode}`);
		} finally {
			await context.close();
		}
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

export async function runBundleCheckCli(argv: readonly string[]): Promise<void> {
	const directory = argv[0];
	if (!directory || argv.length !== 1)
		throw new Error("bundle:check requires exactly one bundle directory");
	await checkExtensionBundle(path.resolve(directory));
	console.info(`bundle check passed: ${path.resolve(directory)}`);
}
