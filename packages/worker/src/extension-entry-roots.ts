import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import type { DiscoveredExtensionEntry } from "@leitwerk-dev/extension-runtime";

function isWithinDirectory(parentDir: string, candidatePath: string): boolean {
	const relative = path.relative(parentDir, candidatePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function parseExtensionAllowedRoots(value: string | undefined): string[] {
	if (!value) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) return [];
	return parsed.flatMap((entry) => {
		if (!path.isAbsolute(entry) || !existsSync(entry)) return [];
		return [realpathSync(entry)];
	});
}

export function entriesExistWithinAllowedRoots(input: {
	entries: readonly DiscoveredExtensionEntry[];
	allowedRoots: readonly string[];
}): boolean {
	if (input.entries.length === 0) return true;
	if (input.allowedRoots.length === 0) return false;
	const roots = input.allowedRoots.map((root) => realpathSync(root));
	return input.entries.every((entry) => {
		if (!existsSync(entry.packageDir) || !existsSync(entry.entryPath)) return false;
		const packageDir = realpathSync(entry.packageDir);
		const entryPath = realpathSync(entry.entryPath);
		return roots.some(
			(root) =>
				isWithinDirectory(root, packageDir) &&
				isWithinDirectory(root, entryPath) &&
				isWithinDirectory(packageDir, entryPath),
		);
	});
}
