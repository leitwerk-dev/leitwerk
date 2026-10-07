import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LeitwerkConfig } from "@leitwerk-dev/server";
import { configureSandboxStorage } from "./config.js";
import { createSandboxApp, type SandboxCompositionFactory, type SandboxInput } from "./index.js";
import { loadSandboxRuntime } from "./runtime.js";

/** @internal */
export async function preflightSandbox(
	config: LeitwerkConfig,
	input: SandboxInput,
	factory: SandboxCompositionFactory,
): Promise<void> {
	const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-sandbox-preflight-"));
	const isolated = { ...input, paths: { ...input.paths, root: directory, directory } };
	const candidate = structuredClone(config);
	configureSandboxStorage(candidate, isolated.paths);
	try {
		const sandbox = await createSandboxApp(candidate, isolated, factory);
		try {
			await sandbox.context.app.ready();
		} finally {
			await sandbox.stop();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const { config, input, factory } = await loadSandboxRuntime();
	await preflightSandbox(config, input, factory);
}
