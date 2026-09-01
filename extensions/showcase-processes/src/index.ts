import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { coreHostCapabilities } from "@leitwerk-dev/process-sdk";
import { createFileExternalSourceProvider } from "./file-external.js";
import { createFilesystemWatcherProvider } from "./filesystem-watcher.js";
import {
	k8sSmokeLongProcess,
	k8sSmokeProcess,
	k8sSmokeSpecializedProcess,
	poemCreatorProcess,
	singlePromptExternalCompleteProcess,
	singlePromptProcess,
	singlePromptWithToolProcess,
} from "./process-definition.js";
import { leaveFeedbackToolRenderer } from "./turns/poem-creator.js";

export interface SinglePromptExtensionConfig {
	file_triggers?: {
		poll_interval?: string;
		poem_review_path?: string;
		complete_prompt_path?: string;
	};
}

export const manifest = {
	id: "showcase-processes",
	version: "0.1.0",
} as const;

const fileTriggerDefaults = {
	poll_interval: "1s",
	poem_review_path: "/tmp/poem-review-{instanceId}",
	complete_prompt_path: "/tmp/complete-prompt",
};

const singlePromptExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.registerToolRenderer(leaveFeedbackToolRenderer);
		api.registerProcess(singlePromptProcess);
		api.registerProcess(singlePromptWithToolProcess);
		api.registerProcess(singlePromptExternalCompleteProcess);
		api.registerProcess(k8sSmokeProcess);
		api.registerProcess(k8sSmokeSpecializedProcess);
		api.registerProcess(k8sSmokeLongProcess);
		api.registerProcess(poemCreatorProcess);
	},
	setupServer(api, rawConfig) {
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) {
			return;
		}
		const config = (rawConfig ?? {}) as SinglePromptExtensionConfig;
		const resolvedFileTriggerConfig = {
			...fileTriggerDefaults,
			...config.file_triggers,
		};
		createFileExternalSourceProvider(deps, {
			"/tmp/complete-prompt": resolvedFileTriggerConfig.complete_prompt_path,
			"/tmp/poem-review-{instanceId}": resolvedFileTriggerConfig.poem_review_path,
		});
		createFilesystemWatcherProvider(deps);
	},
};

export default singlePromptExtension;

export * from "./file-external.js";
export * from "./filesystem-watcher.js";
export * from "./poem-leaf-outcome.js";
export * from "./process-definition.js";
export * from "./turns/external-complete.js";
export * from "./turns/poem-creator.js";
export * from "./turns/run-single-prompt.js";
