import path from "node:path";
import { coreHostCapabilities, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { processAnalysisProcess } from "./process-definition.js";
import { configureProcessAnalysisRuntime } from "./server-runtime.js";
import { registerProcessAnalysisTools } from "./tools.js";

/** @internal */
const manifest = {
	/** @internal */
	id: "process-analysis",
	/** @internal */
	version: "0.1.0",
} as const;

/** @public */
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
