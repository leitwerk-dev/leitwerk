import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { coreHostCapabilities } from "@leitwerk-dev/process-sdk";
import { createFileExternalSourceProvider } from "./file-external.js";
import {
	k8sSmokeLongProcess,
	k8sSmokeProcess,
	k8sSmokeSpecializedProcess,
	singlePromptExternalCompleteProcess,
	singlePromptProcess,
	singlePromptWithToolProcess,
} from "./process-definition.js";

/** @internal */
interface ExampleProcessesConfig {
	/** @internal */
	file_triggers?: {
		/** @internal */
		poll_interval?: string;
		/** @internal */
		complete_prompt_path?: string;
	};
}

/** @internal */
const manifest = {
	/** @internal */
	id: "example-processes",
	/** @internal */
	version: "0.1.0",
} as const;

const fileTriggerDefaults = {
	poll_interval: "1s",
	complete_prompt_path: "/tmp/complete-prompt",
};

/** @public */
const exampleProcessesExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.registerProcess(singlePromptProcess);
		api.registerProcess(singlePromptWithToolProcess);
		api.registerProcess(singlePromptExternalCompleteProcess);
		api.registerProcess(k8sSmokeProcess);
		api.registerProcess(k8sSmokeSpecializedProcess);
		api.registerProcess(k8sSmokeLongProcess);
	},
	setupServer(api, rawConfig) {
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) {
			return;
		}
		const config = (rawConfig ?? {}) as ExampleProcessesConfig;
		const resolvedFileTriggerConfig = {
			...fileTriggerDefaults,
			...config.file_triggers,
		};
		createFileExternalSourceProvider(deps, {
			"/tmp/complete-prompt": resolvedFileTriggerConfig.complete_prompt_path,
		});
	},
};

export default exampleProcessesExtension;
