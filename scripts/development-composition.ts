import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export const COMPOSITION_ENV = "LEITWERK_COMPOSITION_PATH";

interface CompositionManifest {
	version?: unknown;
	leitwerk?: { root?: unknown };
	runtime_config?: unknown;
	workspace_root?: unknown;
	extensions?: unknown;
	test_roots?: unknown;
}

interface RootPackageJson {
	workspaces?: unknown;
}

export interface ComposedPackage {
	name: string;
	dir: string;
	packageJson: Record<string, unknown>;
}

export interface DevelopmentComposition {
	manifestPath: string;
	manifestDir: string;
	leitwerkRoot: string;
	workspaceRoot: string;
	runtimeConfigPath: string;
	extensionDirs: string[];
	testRoots: string[];
	externalPackages: ComposedPackage[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function optionalStringArray(value: unknown, label: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
		throw new Error(`${label} must be an array of non-empty strings`);
	}
	return value as string[];
}

function resolveExisting(baseDir: string, declaredPath: string, label: string): string {
	const resolved = path.resolve(baseDir, declaredPath);
	if (!existsSync(resolved)) throw new Error(`${label} does not exist at '${resolved}'`);
	return realpathSync(resolved);
}

function workspacePatterns(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (isRecord(value) && Array.isArray(value.packages)) {
		return value.packages.filter((item): item is string => typeof item === "string");
	}
	return [];
}

function expandWorkspacePattern(root: string, pattern: string): string[] {
	if (pattern.endsWith("/*")) {
		const baseDir = path.resolve(root, pattern.slice(0, -2));
		if (!existsSync(baseDir)) return [];
		return readdirSync(baseDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => path.join(baseDir, entry.name))
			.filter((dir) => existsSync(path.join(dir, "package.json")));
	}
	const dir = path.resolve(root, pattern);
	return existsSync(path.join(dir, "package.json")) ? [dir] : [];
}

function readPackage(dir: string): ComposedPackage {
	const packageJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as unknown;
	if (!isRecord(packageJson) || typeof packageJson.name !== "string") {
		throw new Error(`Composed package '${dir}' must have a string package.json name`);
	}
	return { name: packageJson.name, dir: realpathSync(dir), packageJson };
}

function isInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function manifestArgument(argv: readonly string[]): string | undefined {
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--composition") return argv[index + 1];
		if (value?.startsWith("--composition=")) return value.slice("--composition=".length);
	}
	return undefined;
}

export function activateDevelopmentComposition(
	leitwerkRoot = process.cwd(),
	argv: readonly string[] = process.argv.slice(2),
): DevelopmentComposition | null {
	const declaredManifest = manifestArgument(argv) ?? process.env[COMPOSITION_ENV];
	if (!declaredManifest) return null;
	const manifestPath = realpathSync(path.resolve(process.cwd(), declaredManifest));
	process.env[COMPOSITION_ENV] = manifestPath;
	const composition = loadDevelopmentComposition(manifestPath, leitwerkRoot);
	if (!process.env.LEITWERK_CONFIG_PATH) {
		process.env.LEITWERK_CONFIG_PATH = composition.runtimeConfigPath;
	}
	return composition;
}

export function loadActiveDevelopmentComposition(
	leitwerkRoot = process.cwd(),
): DevelopmentComposition | null {
	const manifestPath = process.env[COMPOSITION_ENV];
	return manifestPath ? loadDevelopmentComposition(manifestPath, leitwerkRoot) : null;
}

export function loadDevelopmentComposition(
	manifestPath: string,
	executingLeitwerkRoot: string,
): DevelopmentComposition {
	const absoluteManifestPath = realpathSync(path.resolve(manifestPath));
	const manifestDir = path.dirname(absoluteManifestPath);
	const parsed = parseYaml(readFileSync(absoluteManifestPath, "utf8")) as unknown;
	if (!isRecord(parsed)) throw new Error("Development composition must be a YAML object");
	const manifest = parsed as CompositionManifest;
	if (manifest.version !== 1) throw new Error("Development composition version must be 1");
	if (!isRecord(manifest.leitwerk))
		throw new Error("Development composition must declare leitwerk.root");
	const leitwerkRoot = resolveExisting(
		manifestDir,
		requiredString(manifest.leitwerk.root, "leitwerk.root"),
		"leitwerk.root",
	);
	const currentRoot = realpathSync(path.resolve(executingLeitwerkRoot));
	if (leitwerkRoot !== currentRoot) {
		throw new Error(
			`Composition targets Leitwerk checkout '${leitwerkRoot}', but the command is running from '${currentRoot}'`,
		);
	}
	const workspaceRoot = resolveExisting(
		manifestDir,
		typeof manifest.workspace_root === "string" ? manifest.workspace_root : ".",
		"workspace_root",
	);
	const runtimeConfigPath = resolveExisting(
		manifestDir,
		requiredString(manifest.runtime_config, "runtime_config"),
		"runtime_config",
	);
	const extensionDirs = optionalStringArray(manifest.extensions, "extensions").map((entry) =>
		resolveExisting(manifestDir, entry, `Extension '${entry}'`),
	);
	const testRoots = optionalStringArray(manifest.test_roots, "test_roots").map((entry) =>
		resolveExisting(manifestDir, entry, `Test root '${entry}'`),
	);

	const rootPackageJson = JSON.parse(
		readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
	) as RootPackageJson;
	const packageDirs = workspacePatterns(rootPackageJson.workspaces).flatMap((pattern) =>
		expandWorkspacePattern(workspaceRoot, pattern),
	);
	for (const extensionDir of extensionDirs) packageDirs.push(extensionDir);
	const byRealPath = new Map<string, ComposedPackage>();
	for (const packageDir of packageDirs) {
		const packageInfo = readPackage(packageDir);
		byRealPath.set(packageInfo.dir, packageInfo);
	}
	const externalPackages = [...byRealPath.values()]
		.filter((entry) => !isInside(leitwerkRoot, entry.dir))
		.sort((left, right) => left.name.localeCompare(right.name));
	const byName = new Map<string, string>();
	for (const packageInfo of [...externalPackages, ...extensionDirs.map(readPackage)]) {
		const previous = byName.get(packageInfo.name);
		if (previous && previous !== packageInfo.dir) {
			throw new Error(
				`Composition contains duplicate package '${packageInfo.name}' at '${previous}' and '${packageInfo.dir}'`,
			);
		}
		byName.set(packageInfo.name, packageInfo.dir);
	}

	return {
		manifestPath: absoluteManifestPath,
		manifestDir,
		leitwerkRoot,
		workspaceRoot,
		runtimeConfigPath,
		extensionDirs: [...new Set(extensionDirs)].sort(),
		testRoots: [...new Set(testRoots)].sort(),
		externalPackages,
	};
}

export function externalPackageProjects(composition: DevelopmentComposition): string[] {
	return composition.externalPackages
		.map((entry) => path.join(entry.dir, "tsconfig.json"))
		.filter(existsSync);
}
