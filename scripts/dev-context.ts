import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	type DiscoveredExtensionEntry,
	resolveExtensionEntries,
} from "../packages/extension-runtime/src/extension-loader.ts";
import { loadConfig } from "../packages/server/src/config/config-loader.ts";
import {
	activateDevelopmentComposition,
	loadActiveDevelopmentComposition,
} from "./development-composition.ts";

interface ExtensionPackageJson {
	name?: unknown;
	scripts?: Record<string, unknown>;
	leitwerk?: {
		ui?: { source?: unknown; import?: unknown };
	};
}

interface ExtensionUiSourceManifest {
	extensionManifestId?: unknown;
}

export interface DevExtensionUiSource {
	extensionManifestId: string;
	manifestPath: string;
	assetRootDir: string;
	packageRootDir: string;
}

export interface DevExtension extends DiscoveredExtensionEntry {
	packageJson: ExtensionPackageJson;
	uiSource: DevExtensionUiSource | null;
}

export interface DevContext {
	configPath: string;
	configDirectory: string;
	extensions: DevExtension[];
}

const EXTENSION_MANIFEST_ID_RE = /^[A-Za-z0-9._-]+$/;

function resolveWithinPackage(packageDir: string, relativePath: string, label: string): string {
	const resolvedPackageDir = path.resolve(packageDir);
	const resolvedPath = path.resolve(resolvedPackageDir, relativePath);
	const relative = path.relative(resolvedPackageDir, resolvedPath);
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`${label} must stay within '${resolvedPackageDir}'`);
	}
	return resolvedPath;
}

async function loadExtensionUiSource(
	entry: DiscoveredExtensionEntry,
	packageJson: ExtensionPackageJson,
): Promise<DevExtensionUiSource | null> {
	const uiMetadata = packageJson.leitwerk?.ui;
	if (uiMetadata === undefined) return null;
	if (typeof uiMetadata.source !== "string" || uiMetadata.source.trim() === "") {
		throw new Error(
			`Extension package '${entry.packageName}' must declare leitwerk.ui.source as a string path`,
		);
	}
	const manifestPath = resolveWithinPackage(
		entry.packageDir,
		uiMetadata.source,
		`leitwerk.ui.source for '${entry.packageName}'`,
	);
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExtensionUiSourceManifest;
	if (
		typeof manifest.extensionManifestId !== "string" ||
		!EXTENSION_MANIFEST_ID_RE.test(manifest.extensionManifestId)
	) {
		throw new Error(
			`Source UI manifest for '${entry.packageName}' must declare a URL-safe extensionManifestId`,
		);
	}
	return {
		extensionManifestId: manifest.extensionManifestId,
		manifestPath,
		assetRootDir: path.dirname(manifestPath),
		packageRootDir: path.resolve(entry.packageDir),
	};
}

export async function loadDevContext(
	configPath = process.env.LEITWERK_CONFIG_PATH,
): Promise<DevContext> {
	process.env.LEITWERK_RUNTIME_LANE = "source";
	activateDevelopmentComposition(process.cwd());
	const composition = loadActiveDevelopmentComposition(process.cwd());
	const loaded = loadConfig(configPath ?? composition?.runtimeConfigPath);
	if (!loaded.ok) throw new Error(loaded.error);
	const configDirectory =
		loaded.filePath === "<defaults>" ? process.cwd() : path.dirname(loaded.filePath);
	const entries = await resolveExtensionEntries({
		startDir: configDirectory,
		sources: [...loaded.config.extension_loading.sources, ...(composition?.extensionDirs ?? [])],
	});
	const extensions = await Promise.all(
		entries.map(async (entry): Promise<DevExtension> => {
			const packageJson = JSON.parse(
				await readFile(path.join(entry.packageDir, "package.json"), "utf8"),
			) as ExtensionPackageJson;
			return {
				...entry,
				packageJson,
				uiSource: await loadExtensionUiSource(entry, packageJson),
			};
		}),
	);
	return { configPath: loaded.filePath, configDirectory, extensions };
}
