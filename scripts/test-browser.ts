import { mkdirSync, mkdtempSync } from "node:fs";
import { availableParallelism } from "node:os";
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
	// Separate runners isolate the API/UI ports, Vite cache, and artifacts.
	// Keep one shard per engine on smaller hosts to avoid resource contention.
	const shardCount = availableParallelism() >= 6 ? 2 : 1;
	const runners = ["chromium", "firefox", "webkit"].flatMap((engine) =>
		Array.from({ length: shardCount }, (_, index) => {
			const name = `${engine}-${index + 1}`;
			return {
				name,
				command: `LEITWERK_BROWSER_ENGINE=${engine} LEITWERK_BROWSER_OUTPUT_NAME=${name} playwright test --shard=${index + 1}/${shardCount}`,
			};
		}),
	);
	runCommand(
		"npx",
		[
			"concurrently",
			"--kill-others-on-fail",
			"--names",
			runners.map(({ name }) => name).join(","),
			...runners.map(({ command }) => command),
		],
		{ env },
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
