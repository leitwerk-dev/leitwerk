import { cp, mkdir, mkdtempDisposable, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type LeitwerkConfig, loadConfig, runExtensionBootCheck } from "@leitwerk-dev/server";
import type { ExtensionBundleManifest } from "./bundle.js";
import { packageDirectory, readJson } from "./workspace.js";

/** Run the built-artifact bundle boot check. @internal */
export async function checkExtensionBundle(
	bundleDir: string,
	config: LeitwerkConfig,
): Promise<void> {
	const manifest = readJson<ExtensionBundleManifest>(path.join(bundleDir, "bundle.json"));
	await using scratch = await mkdtempDisposable(path.join(tmpdir(), "leitwerk-bundle-check-"));
	// Keep the check outside the workspace so hoisted dependencies cannot mask missing imports.
	for (const host of manifest.hostPackages) {
		const installedDir = packageDirectory(host.name, process.cwd());
		const { version } = readJson(path.join(installedDir, "package.json"));
		if (version !== host.version)
			throw new Error(
				`Host package '${host.name}' version mismatch: required '${host.version}', installed '${version}'`,
			);
		const target = path.join(scratch.path, "node_modules", host.name);
		await mkdir(path.dirname(target), { recursive: true });
		await symlink(installedDir, target);
	}
	const checkedBundle = path.join(scratch.path, "bundle");
	await cp(bundleDir, checkedBundle, { recursive: true });
	const sources = manifest.sources.map(({ packageName }) =>
		path.join(checkedBundle, "node_modules", packageName),
	);
	await runExtensionBootCheck(
		{ ...config, extension_loading: { ...config.extension_loading, sources } },
		{ extensionLoadingStartDir: checkedBundle },
	);
}

export async function runBundleCheckCli(argv: readonly string[]): Promise<void> {
	const [directory, option, configPath] = argv;
	if (!directory || option !== "--config" || !configPath || argv.length !== 3)
		throw new Error("Usage: leitwerk-dev bundle:check DIRECTORY --config FILE");
	const loaded = loadConfig(configPath);
	if (!loaded.ok) throw new Error(loaded.error);
	await checkExtensionBundle(path.resolve(directory), loaded.config);
	console.info(`bundle check passed: ${path.resolve(directory)}`);
}
