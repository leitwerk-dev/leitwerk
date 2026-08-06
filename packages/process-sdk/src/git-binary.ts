import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

// Resolving a bare "git" through child_process forces Node to stat every PATH
// entry on each spawn. On developer machines with long PATHs that is ~60ms per
// call, which dominates git-heavy code paths and tests that fan out into dozens
// of subprocesses. Resolve the absolute path once and reuse it so each spawn
// skips the PATH search.
let cachedGitBinary: string | null = null;

/**
 * Resolve the absolute path to the `git` executable once and cache it.
 *
 * POSIX-only by design (matching the leitwerk platform target). Falls back
 * to the bare `"git"` name when no PATH entry matches so spawning still works
 * and surfaces a clear error from the child process itself.
 */
export function resolveGitBinary(): string {
	if (cachedGitBinary) {
		return cachedGitBinary;
	}
	const pathValue = process.env.PATH ?? "";
	for (const dir of pathValue.split(delimiter)) {
		if (!dir) {
			continue;
		}
		const candidate = join(dir, "git");
		if (existsSync(candidate)) {
			cachedGitBinary = candidate;
			return candidate;
		}
	}
	cachedGitBinary = "git";
	return cachedGitBinary;
}

/** Reset the cached resolution. Intended for tests that mutate PATH. */
export function resetGitBinaryCache(): void {
	cachedGitBinary = null;
}
