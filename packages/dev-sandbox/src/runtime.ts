import { pathToFileURL } from "node:url";
import { loadConfig } from "@leitwerk-dev/server";
import type { SandboxCompositionFactory, SandboxInput } from "./index.js";

export async function loadSandboxRuntime() {
	if (!process.env.LEITWERK_SANDBOX_INPUT || !process.env.LEITWERK_SANDBOX_COMPOSITION_ENTRY)
		throw new Error("Start the sandbox with npm run dev:sandbox");
	const input: SandboxInput = JSON.parse(process.env.LEITWERK_SANDBOX_INPUT);
	const loaded = loadConfig(process.env.LEITWERK_CONFIG_PATH);
	if (!loaded.ok) throw new Error(loaded.error);
	const factory: SandboxCompositionFactory = (
		await import(pathToFileURL(process.env.LEITWERK_SANDBOX_COMPOSITION_ENTRY).href)
	).default;
	return { input, config: loaded.config, factory };
}
