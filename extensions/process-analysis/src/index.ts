import path from "node:path";
import { coreHostCapabilities, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { processAnalysisProcess } from "./process-definition.js";
import { configureProcessAnalysisRuntime } from "./server-runtime.js";
import { registerProcessAnalysisTools } from "./tools.js";

export const manifest = {
	id: "process-analysis",
	version: "0.1.0",
} as const;

const processAnalysisExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.registerProcess(processAnalysisProcess);
	},
	setupServer(api) {
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) return;
		configureProcessAnalysisRuntime({
			analysisCwd: path.resolve(process.cwd()),
			serverBaseUrl: deps.serverBaseUrl,
			processWorkspacesDir: deps.processWorkspacesDir ?? null,
		});
		registerProcessAnalysisTools(api);
	},
};

export default processAnalysisExtension;
export * from "./actions.js";
export * from "./params.js";
export * from "./process-definition.js";
export * from "./process-ref.js";
export * from "./server-runtime.js";
export * from "./snapshot-downloader.js";
export * from "./snapshot-markdown.js";
export * from "./state.js";
export * from "./tools.js";
