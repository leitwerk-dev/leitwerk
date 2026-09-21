import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Expand literal package paths and trailing /* workspace patterns. @internal */
export function listWorkspacePackageDirs(
	rootDir: string,
	manifest: {
		/** @internal */
		workspaces?: unknown;
	} = readJson(path.join(rootDir, "package.json")),
): string[] {
	const workspaces = manifest.workspaces;
	const patterns = Array.isArray(workspaces)
		? workspaces
		: typeof workspaces === "object" &&
				workspaces !== null &&
				"packages" in workspaces &&
				Array.isArray(workspaces.packages)
			? workspaces.packages
			: [];
	const dirs = patterns
		.filter((pattern): pattern is string => typeof pattern === "string")
		.flatMap((pattern) => {
			if (pattern.endsWith("/*")) {
				const baseDir = path.resolve(rootDir, pattern.slice(0, -2));
				if (!existsSync(baseDir)) return [];
				return readdirSync(baseDir, { withFileTypes: true })
					.filter((entry) => entry.isDirectory())
					.map((entry) => path.join(baseDir, entry.name));
			}
			return [path.resolve(rootDir, pattern)];
		})
		.filter((dir) => existsSync(path.join(dir, "package.json")));
	return [...new Set(dirs)].sort((left, right) => left.localeCompare(right));
}

/** @internal */
export interface WorkspacePackage extends PackageManifest, Record<string, unknown> {
	/** @internal */
	name: string;
	/** @internal */
	dir: string;
}

/** @internal */
export interface PackageManifest {
	/** @internal */
	name?: string;
	/** @internal */
	version?: string;
	/** @internal */
	workspaces?: unknown;
	/** @internal */
	bin?: string | Record<string, string>;
	/** @internal */
	scripts?: Record<string, string>;
	/** @internal */
	dependencies?: Record<string, string>;
	/** @internal */
	devDependencies?: Record<string, string>;
	/** @internal */
	optionalDependencies?: Record<string, string>;
}

/** @internal */
export function readJson<T = PackageManifest>(file: string): T {
	return JSON.parse(readFileSync(file, "utf8"));
}

function isPackageName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) &&
		name
			.replace(/^@/, "")
			.split("/")
			.every((part) => part !== "." && part !== "..")
	);
}

/** Resolve package metadata even when package.json is not exported. @internal */
export function packageDirectory(name: string, from: string): string {
	if (!isPackageName(name)) {
		throw new Error(`Invalid package name: ${name}`);
	}
	const require = createRequire(path.join(from, "package.json"));
	for (const parent of require.resolve.paths(name) ?? []) {
		const candidate = path.join(parent, name);
		if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
	}
	throw new Error(`${name} is not installed in ${from}. Run npm ci.`);
}

/** @internal */
export function readWorkspacePackage(dir: string): WorkspacePackage {
	const manifest = readJson(path.join(dir, "package.json"));
	if (!manifest || !isPackageName(manifest.name))
		throw new Error(`Package at ${dir} needs a valid package name`);
	return { ...manifest, name: manifest.name, dir: realpathSync(dir) };
}

/** @internal */
export function workspacePackages(root: string): WorkspacePackage[] {
	return listWorkspacePackageDirs(root).map(readWorkspacePackage);
}

/** @internal */
export function orderedPackages<T extends WorkspacePackage>(
	packages: readonly T[],
	dependencyNames: (entry: T) => string[] = (entry) =>
		Object.keys({ ...entry.dependencies, ...entry.devDependencies }),
): T[] {
	const byName = new Map(packages.map((entry) => [entry.name, entry]));
	if (byName.size !== packages.length) throw new Error("Duplicate workspace package names");
	const ordered: T[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();
	function visit(entry: T) {
		if (visited.has(entry.name)) return;
		if (visiting.has(entry.name)) throw new Error(`Circular dependency: ${entry.name}`);
		visiting.add(entry.name);
		for (const name of dependencyNames(entry)) {
			const dependency = byName.get(name);
			if (dependency) visit(dependency);
		}
		visiting.delete(entry.name);
		visited.add(entry.name);
		ordered.push(entry);
	}
	for (const entry of packages) visit(entry);
	return ordered;
}

/** @internal */
export function isInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}
