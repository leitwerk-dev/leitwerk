import {
	coreHostCapabilities,
	createFileExternalSourceProvider,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { FILE_EXTERNAL_INSTRUCTION_KIND } from "./file-external.js";
import { createFilesystemWatcherProvider } from "./filesystem-watcher.js";
import { poemCreatorProcess } from "./process-definition.js";
import { leaveFeedbackToolRenderer } from "./turns/poem-creator.js";

/** @internal */
interface ShowcaseProcessesConfig {
	/** @internal */
	file_triggers?: {
		/** @internal */
		poll_interval?: string;
		/** @internal */
		poem_review_path?: string;
	};
}

/** @internal */
const manifest = {
	/** @internal */
	id: "showcase-processes",
	/** @internal */
	version: "0.1.0",
} as const;

/** @public */
const showcaseProcessesExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.registerToolRenderer(leaveFeedbackToolRenderer);
		api.registerProcess(poemCreatorProcess);
	},
	setupServer(api, rawConfig) {
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) {
			return;
		}
		const config = (rawConfig ?? {}) as ShowcaseProcessesConfig;
		createFileExternalSourceProvider(deps, {
			id: "showcase-file-external",
			kind: FILE_EXTERNAL_INSTRUCTION_KIND,
			inputMode: "instruction",
			aliases: { "/tmp/poem-review-{instanceId}": config.file_triggers?.poem_review_path },
		});
		createFilesystemWatcherProvider(deps);
	},
};

export default showcaseProcessesExtension;
export {
	buildPoemLeafOutcomeFallbackMarkdown,
	buildPoemLeafOutcomePayload,
} from "./poem-leaf-outcome.js";
