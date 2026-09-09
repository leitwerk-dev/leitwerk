import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Expand literal package paths and trailing /* workspace patterns. */
export function listWorkspacePackageDirs(
	rootDir: string,
	manifest: { workspaces?: unknown } = JSON.parse(
		readFileSync(path.join(rootDir, "package.json"), "utf8"),
	),
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
