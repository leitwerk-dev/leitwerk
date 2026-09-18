import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

function executableOnPath(name: string, searchPath: string): string | undefined {
	for (const directory of searchPath.split(path.delimiter)) {
		const candidate = path.resolve(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return realpathSync(candidate);
		} catch {
			// Continue past missing or non-executable PATH entries.
		}
	}
	return undefined;
}

/** Resolve Apple's developer-tool launcher once, not on every Git subprocess. */
export function validationEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	findDeveloperGit: () => string = () =>
		execFileSync("/usr/bin/xcrun", ["--find", "git"], { env, encoding: "utf8" }).trim(),
): NodeJS.ProcessEnv {
	const result = { ...env };
	if (platform !== "darwin") return result;
	const searchPath = env.PATH ?? "/usr/bin:/bin";
	// Respect explicitly selected Homebrew Git, wrappers, and other installations.
	if (executableOnPath("git", searchPath) !== "/usr/bin/git") return result;
	const git = findDeveloperGit();
	if (!path.isAbsolute(git) || path.basename(git) !== "git") {
		throw new Error(`xcrun did not resolve an absolute Git executable: ${git}`);
	}
	const directory = path.dirname(git);
	const executable = executableOnPath("git", directory);
	if (!executable || executable === "/usr/bin/git") {
		throw new Error(`xcrun did not resolve a direct Git executable: ${git}`);
	}
	result.PATH = `${directory}${path.delimiter}${searchPath}`;
	return result;
}
