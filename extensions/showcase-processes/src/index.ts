import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { coreHostCapabilities } from "@leitwerk-dev/process-sdk";
import { createFileExternalSourceProvider } from "./file-external.js";
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

const fileTriggerDefaults = {
	poll_interval: "1s",
	poem_review_path: "/tmp/poem-review-{instanceId}",
};

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
		const resolvedFileTriggerConfig = {
			...fileTriggerDefaults,
			...config.file_triggers,
		};
		createFileExternalSourceProvider(deps, {
			"/tmp/poem-review-{instanceId}": resolvedFileTriggerConfig.poem_review_path,
		});
		createFilesystemWatcherProvider(deps);
	},
};

export default showcaseProcessesExtension;
export {
	buildPoemLeafOutcomeFallbackMarkdown,
	buildPoemLeafOutcomePayload,
} from "./poem-leaf-outcome.js";
