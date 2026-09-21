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

/** @internal */
interface SinglePromptExtensionConfig {
	/** @internal */
	file_triggers?: {
		/** @internal */
		poll_interval?: string;
		/** @internal */
		poem_review_path?: string;
		/** @internal */
		complete_prompt_path?: string;
	};
}

/** @internal */
const manifest = {
	/** @internal */
	id: "showcase-processes",
	/** @internal */
	version: "0.1.0",
} as const;

const fileTriggerDefaults = {
	poll_interval: "1s",
	poem_review_path: "/tmp/poem-review-{instanceId}",
	complete_prompt_path: "/tmp/complete-prompt",
};

/** @public */
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
export {
	buildPoemLeafOutcomeFallbackMarkdown,
	buildPoemLeafOutcomePayload,
} from "./poem-leaf-outcome.js";
