import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "@leitwerk-dev/server";
import { loadWorkspaceComposition } from "./composition.js";
import { packageDirectory, readJson, type WorkspacePackage } from "./workspace.js";

export interface BundleSource {
	source: string;
	packageName: string;
	path: string;
}

export interface ExtensionBundleManifest {
	formatVersion: 1;
	digest: string;
	packages: Array<{ name: string; version?: string; path: string }>;
	hostPackages: Array<{ name: string; version?: string }>;
	sources: BundleSource[];
}

type PackageRecord = WorkspacePackage & {
	files?: unknown;
	leitwerk?: { pi?: unknown; skills?: unknown };
};

function hostPackage(name: string): boolean {
	return name.startsWith("@leitwerk-dev/") || name.startsWith("@earendil-works/");
}

function packagePath(root: string, name: string, workspace: Map<string, WorkspacePackage>): string {
	const local = workspace.get(name);
	if (local) return local.dir;
	return packageDirectory(name, root);
}

function matchesFile(relative: string, patterns: string[]): boolean {
	const normalized = relative.split(path.sep).join("/");
	const positive = patterns.filter((item) => !item.startsWith("!"));
	const negative = patterns.filter((item) => item.startsWith("!")).map((item) => item.slice(1));
	const match = (pattern: string) => {
		const escaped = pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*/g, ".*")
			.replace(/\*/g, "[^/]*");
		return new RegExp(`^${escaped}$`).test(normalized);
	};
	return (positive.length === 0 || positive.some(match)) && !negative.some(match);
}

async function filesUnder(root: string, relative = ""): Promise<string[]> {
	const directory = path.join(root, relative);
	const result: string[] = [];
	for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const child = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.isDirectory()) result.push(...(await filesUnder(root, child)));
		else if (entry.isFile()) result.push(child);
	}
	return result;
}

async function selectedFiles(root: string, manifest: PackageRecord): Promise<string[]> {
	const patterns = Array.isArray(manifest.files)
		? manifest.files.filter((x): x is string => typeof x === "string")
		: [];
	const files = await filesUnder(root);
	const selected = files.filter((file) => matchesFile(file, patterns));
	for (const required of ["package.json", "README", "README.md", "LICENSE", "LICENSE.md"]) {
		const actual = files.find((file) => file.toLowerCase() === required.toLowerCase());
		if (actual && !selected.includes(actual)) selected.push(actual);
	}
	return selected.sort();
}

function declaredResourcePaths(manifest: PackageRecord): string[] {
	const pi = manifest.leitwerk?.pi;
	const values: string[] = [];
	if (pi && typeof pi === "object" && !Array.isArray(pi)) {
		const resources = (pi as { resources?: unknown }).resources;
		if (resources && typeof resources === "object" && !Array.isArray(resources)) {
			for (const value of Object.values(resources))
				if (Array.isArray(value))
					values.push(...value.filter((x): x is string => typeof x === "string"));
		}
	}
	if (typeof manifest.leitwerk?.skills === "string") values.push(manifest.leitwerk.skills);
	return values;
}

async function copyPackage(
	destination: string,
	source: string,
	manifest: PackageRecord,
): Promise<void> {
	const files = await selectedFiles(source, manifest);
	for (const relative of files) {
		const from = path.join(source, relative);
		const to = path.join(destination, relative);
		await mkdir(path.dirname(to), { recursive: true });
		const mode = (await stat(from)).mode & 0o111 ? 0o755 : 0o644;
		await cp(from, to);
		await chmod(to, mode);
	}
	for (const resource of declaredResourcePaths(manifest)) {
		const target = path.resolve(source, resource);
		if (
			!target.startsWith(`${path.resolve(source)}${path.sep}`) ||
			!(await stat(target).catch(() => null))
		)
			throw new Error(
				`Extension package '${manifest.name}' declares missing resource '${resource}'`,
			);
	}
}

/** Build the deterministic, path-sourced extension bundle. @public */
export async function buildExtensionBundle(
	compositionPath: string,
	output: string,
): Promise<ExtensionBundleManifest> {
	const composition = loadWorkspaceComposition(compositionPath);
	const loaded = loadConfig(composition.runtimeConfigPath);
	if (!loaded.ok) throw new Error(loaded.error);
	const configDir = path.dirname(loaded.filePath);
	const sourceList = [...loaded.config.extension_loading.sources, ...composition.extensionDirs];
	const sourceRecords: BundleSource[] = [];
	const workspace = new Map(composition.packages.map((entry) => [entry.name, entry]));
	const roots: PackageRecord[] = [];
	for (const source of sourceList) {
		const resolved =
			path.isAbsolute(source) || source.startsWith(".") ? path.resolve(configDir, source) : null;
		if (!resolved) continue;
		const packageJson = path.join(resolved, "package.json");
		const manifest = readJson<PackageRecord>(packageJson);
		if (typeof manifest.name !== "string")
			throw new Error(`Extension source '${source}' has no package name`);
		roots.push({ ...manifest, name: manifest.name, dir: resolved });
		sourceRecords.push({
			source: path.isAbsolute(source)
				? path.relative(composition.manifestDir, resolved).split(path.sep).join("/")
				: source,
			packageName: manifest.name,
			path: path.relative(composition.manifestDir, resolved).split(path.sep).join("/"),
		});
	}
	const packages = new Map<string, PackageRecord>();
	const visit = (entry: PackageRecord) => {
		if (packages.has(entry.name) || hostPackage(entry.name)) return;
		packages.set(entry.name, entry);
		for (const dependency of Object.keys({
			...entry.dependencies,
			...entry.optionalDependencies,
		})) {
			if (hostPackage(dependency)) continue;
			const dir = packagePath(process.cwd(), dependency, workspace);
			const manifest = readJson<PackageRecord>(path.join(dir, "package.json"));
			visit({ ...manifest, name: dependency, dir });
		}
	};
	roots.forEach(visit);
	const staging = `${output}.staging-${process.pid}`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(path.join(staging, "node_modules"), { recursive: true });
	for (const entry of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
		await copyPackage(path.join(staging, "node_modules", entry.name), entry.dir, entry);
	}
	const hash = createHash("sha256");
	for (const entry of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
		for (const file of await selectedFiles(entry.dir, entry)) {
			const target = path.join(staging, "node_modules", entry.name, file);
			hash.update(`${entry.name}/${file}\0${(await stat(target)).mode & 0o777}\0`);
			hash.update(await readFile(target));
		}
	}
	const manifest: ExtensionBundleManifest = {
		formatVersion: 1,
		digest: hash.digest("hex"),
		packages: [...packages.values()]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((entry) => ({
				name: entry.name,
				version: entry.version,
				path: `node_modules/${entry.name}`,
			})),
		hostPackages: [
			...new Set([
				...roots.flatMap((entry) =>
					Object.keys({ ...entry.dependencies, ...entry.optionalDependencies }),
				),
				...[...packages.values()].flatMap((entry: PackageRecord) =>
					Object.keys({ ...entry.dependencies, ...entry.optionalDependencies }),
				),
			]),
		]
			.filter(hostPackage)
			.sort()
			.map((name) => ({
				name,
				version: readJson<PackageRecord>(
					path.join(packagePath(process.cwd(), name, workspace), "package.json"),
				).version,
			})),
		sources: sourceRecords,
	};
	await writeFile(path.join(staging, "bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	await rm(output, { recursive: true, force: true });
	await mkdir(path.dirname(path.resolve(output)), { recursive: true });
	await cp(staging, output, { recursive: true });
	await rm(staging, { recursive: true, force: true });
	return manifest;
}

export async function runBundleCli(argv: readonly string[]): Promise<void> {
	const outIndex = argv.indexOf("--out");
	const output = outIndex >= 0 ? argv[outIndex + 1] : "extension-bundle";
	if (!output) throw new Error("--out requires a directory");
	const compositionIndex = argv.indexOf("--composition");
	const composition =
		compositionIndex >= 0 ? argv[compositionIndex + 1] : process.env.LEITWERK_COMPOSITION_PATH;
	if (!composition) throw new Error("bundle requires --composition");
	const manifest = await buildExtensionBundle(composition, output);
	console.info(`${manifest.digest} ${output}`);
}
