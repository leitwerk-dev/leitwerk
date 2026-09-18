import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "./run-command.js";
import { validationEnvironment } from "./validation-environment.js";

export function createBrowserOutputRoot(repoRoot: string): string {
	const parent = path.join(repoRoot, "test-results");
	mkdirSync(parent, { recursive: true });
	return mkdtempSync(path.join(parent, "browser-"));
}

export function browserOutputDir(env: NodeJS.ProcessEnv): string | undefined {
	const root = env.LEITWERK_BROWSER_OUTPUT_ROOT;
	return root
		? path.join(root, env.LEITWERK_BROWSER_OUTPUT_NAME ?? env.LEITWERK_BROWSER_ENGINE ?? "all")
		: undefined;
}

function main() {
	const outputRoot = createBrowserOutputRoot(process.cwd());
	console.info(`[test:browser] artifacts: ${outputRoot}`);
	const env = {
		...validationEnvironment(),
		LEITWERK_BROWSER_OUTPUT_ROOT: outputRoot,
		NODE_OPTIONS: [process.env.NODE_OPTIONS, "--no-deprecation"].filter(Boolean).join(" "),
	};
	// Firefox's layout check still runs after every other engine has finished.
	runCommand(
		"npx",
		[
			"concurrently",
			"--kill-others-on-fail",
			"--names",
			"chromium,firefox,webkit",
			"LEITWERK_BROWSER_ENGINE=chromium playwright test",
			"LEITWERK_BROWSER_ENGINE=firefox playwright test --grep-invert=waiting.composer.preserves.the.Firefox.layout",
			"LEITWERK_BROWSER_ENGINE=webkit playwright test",
		],
		{ env },
	);
	runCommand(
		"npx",
		["playwright", "test", "--grep=waiting.composer.preserves.the.Firefox.layout"],
		{
			env: {
				...env,
				LEITWERK_BROWSER_ENGINE: "firefox",
				LEITWERK_BROWSER_OUTPUT_NAME: "firefox-layout",
			},
		},
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
