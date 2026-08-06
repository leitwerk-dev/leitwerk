import path from "node:path";
import { localRepoChangeCapabilities } from "@leitwerk-dev/local-repo-change";
import { coreHostCapabilities, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { createProcessAnalysisProcess } from "./process-definition.js";
import { configureProcessAnalysisRuntime } from "./server-runtime.js";

export const manifest = {
	id: "process-analysis",
	version: "0.1.0",
	optional: ["local-repo-change"],
} as const;

const processAnalysisExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		const planner = api.get(localRepoChangeCapabilities.launchPlanner);
		api.registerProcess(createProcessAnalysisProcess(Array.isArray(planner) ? undefined : planner));
	},
	setupServer(api) {
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (deps && !Array.isArray(deps)) {
			configureProcessAnalysisRuntime({
				analysisCwd: path.resolve(process.cwd()),
				serverBaseUrl: deps.serverBaseUrl,
				processWorkspacesDir: deps.processWorkspacesDir ?? null,
				processLaunches: deps.processLaunches,
			});
		}
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
