import {
	buildWorkerRuntimeDefinition,
	loadExtensionCatalog,
} from "@leitwerk-dev/extension-runtime";
import {
	createTestProcessInstance,
	runWorkerTurnForTest,
} from "@leitwerk-dev/extension-runtime/testing";
import { createAppContext } from "./app.js";
import type { LeitwerkConfig } from "./config/index.js";
import { getDefaultConfig } from "./config/index.js";

/** Run the built extension boot check using only disposable in-memory state. @internal */
export async function runExtensionBootCheck(input: {
	/** @internal */
	config?: LeitwerkConfig;
	/** @internal */
	extensionLoadingStartDir: string;
	/** @internal */
	sources: readonly string[];
}): Promise<void> {
	const config = structuredClone(input.config ?? getDefaultConfig());
	config.storage.sqlite_path = ":memory:";
	config.extension_loading.sources = [...input.sources];
	const catalog = await loadExtensionCatalog({
		startDir: input.extensionLoadingStartDir,
		sources: input.sources,
	});
	if (!catalog) throw new Error("Extension boot check could not load the extension catalog");

	for (const [processId, process] of catalog.processes) {
		const automaticTurn = [...process.turns.entries()].find(
			([, binding]) => binding.definition.kind === "automatic",
		);
		if (automaticTurn && process.worker) {
			const resolved = buildWorkerRuntimeDefinition(process);
			if (!resolved) throw new Error(`Extension worker '${processId}' could not be resolved`);
			const turnHandler = resolved.definition.turns.get(automaticTurn[0]);
			if (!turnHandler)
				throw new Error(`Extension worker '${processId}' could not load its automatic turn`);
			await runWorkerTurnForTest(turnHandler, {
				process: createTestProcessInstance({
					id: "boot-check",
					processId,
					selectedTurnId: automaticTurn[0],
					paramsJson: null,
					stateJson: null,
				}),
				params: resolved.params,
				state: resolved.state,
			});
			break;
		}
	}

	const context = await createAppContext({
		config,
		extensionCatalog: catalog,
		extensionLoadingStartDir: input.extensionLoadingStartDir,
		logger: false,
	});
	try {
		await context.app.listen({ host: "127.0.0.1", port: 0 });
		const health = await context.app.inject({ method: "GET", url: "/api/health" });
		if (health.statusCode !== 200 || health.json().status !== "ok") {
			throw new Error(`Extension boot check failed with HTTP ${health.statusCode}`);
		}
		if (context.isReady())
			throw new Error("Extension boot check started background services unexpectedly");
	} finally {
		await context.close();
	}
}
