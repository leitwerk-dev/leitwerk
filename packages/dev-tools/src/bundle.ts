import { execFile } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import * as extensionRuntime from "@leitwerk-dev/extension-runtime";
import { loadConfig } from "@leitwerk-dev/server";
import { loadWorkspaceComposition } from "./composition.js";
import {
	packageDirectory,
	readJson,
	readWorkspacePackage,
	type WorkspacePackage,
} from "./workspace.js";

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
	leitwerk?: { pi?: { resources?: unknown }; skills?: unknown };
};

function hostPackage(name: string): boolean {
	return name.startsWith("@leitwerk-dev/") || name.startsWith("@earendil-works/");
}

function packagePath(root: string, name: string, workspace: Map<string, WorkspacePackage>): string {
	const local = workspace.get(name);
	if (local) return local.dir;
	return packageDirectory(name, root);
}

const run = promisify(execFile);

async function selectedFiles(root: string): Promise<string[]> {
	const { stdout } = await run("npm", ["pack", ".", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: root,
		env: {
			...process.env,
			PATH: [path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
		},
		maxBuffer: 16 * 1024 * 1024,
	});
	const [pack] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
	return pack.files.map((file) => file.path).sort();
}

async function copyPackage(
	destination: string,
	manifest: PackageRecord,
	hash: Hash,
): Promise<void> {
	for (const relative of await selectedFiles(manifest.dir)) {
		const from = path.join(manifest.dir, relative);
		const to = path.join(destination, relative);
		const contents = await readFile(from);
		const mode = (await stat(from)).mode & 0o111 ? 0o755 : 0o644;
		await mkdir(path.dirname(to), { recursive: true });
		await writeFile(to, contents);
		await chmod(to, mode);
		hash.update(`${manifest.name}/${relative}\0${mode}\0`).update(contents);
	}
	const { skillDirectories, promptDirectories } = extensionRuntime.resolvePiResourceDirectories(
		destination,
		manifest.name,
		manifest.leitwerk?.pi?.resources,
	);
	const skillPack = extensionRuntime.resolveSkillPackPath(destination, manifest.leitwerk?.skills);
	const resources = [...skillDirectories, ...promptDirectories];
	if (skillPack) resources.push(skillPack);
	for (const target of resources) {
		if (!(await stat(target).catch(() => null)))
			throw new Error(
				`Extension package '${manifest.name}' declares missing resource '${path.relative(destination, target)}'`,
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
		const manifest = readWorkspacePackage(resolved);
		roots.push(manifest);
		const relative = path.relative(composition.manifestDir, resolved).split(path.sep).join("/");
		sourceRecords.push({
			source: path.isAbsolute(source) ? relative : source,
			packageName: manifest.name,
			path: relative,
		});
	}
	const packages = new Map<string, PackageRecord>();
	const hosts = new Set<string>();
	const visit = (entry: PackageRecord) => {
		if (packages.has(entry.name) || hostPackage(entry.name)) return;
		packages.set(entry.name, entry);
		for (const dependency of Object.keys({
			...entry.dependencies,
			...entry.optionalDependencies,
		})) {
			if (hostPackage(dependency)) {
				hosts.add(dependency);
				continue;
			}
			if (packages.has(dependency)) continue;
			const dir = packagePath(composition.workspaceRoot, dependency, workspace);
			const manifest = readJson<PackageRecord>(path.join(dir, "package.json"));
			visit({ ...manifest, name: dependency, dir });
		}
	};
	roots.forEach(visit);
	await mkdir(path.dirname(path.resolve(output)), { recursive: true });
	const staging = await mkdtemp(`${path.resolve(output)}.staging-`);
	try {
		const hash = createHash("sha256");
		const packed = [];
		for (const [name, entry] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
			const relative = `node_modules/${name}`;
			await copyPackage(path.join(staging, relative), entry, hash);
			packed.push({ name, version: entry.version, path: relative });
		}
		const manifest: ExtensionBundleManifest = {
			formatVersion: 1,
			digest: hash.digest("hex"),
			packages: packed,
			hostPackages: [...hosts].sort().map((name) => ({
				name,
				version: readJson(
					path.join(packagePath(composition.workspaceRoot, name, workspace), "package.json"),
				).version,
			})),
			sources: sourceRecords,
		};
		await writeFile(path.join(staging, "bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`);
		await rm(output, { recursive: true, force: true });
		await rename(staging, output);
		return manifest;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
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
