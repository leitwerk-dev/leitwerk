import {
	coreHostCapabilities,
	createFileExternalSourceProvider,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { FILE_EXTERNAL_PRESENCE_KIND } from "./file-external.js";
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
		createFileExternalSourceProvider(deps, {
			id: "example-file-external",
			kind: FILE_EXTERNAL_PRESENCE_KIND,
			inputMode: "none",
			aliases: { "/tmp/complete-prompt": config.file_triggers?.complete_prompt_path },
		});
	},
};

export default exampleProcessesExtension;
