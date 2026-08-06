import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { cleanupPersistedLocalShellProcessGroups } from "./command-runner.js";
import { abortAllActiveLocalShellCommands, localShellProcess } from "./process-definition.js";

export const manifest = {
	id: "local-shell",
	version: "0.1.0",
} as const;

const localShellExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.registerProcess(localShellProcess);
	},
	setupServer(api) {
		const cleanedUpProcessGroups = cleanupPersistedLocalShellProcessGroups();
		if (cleanedUpProcessGroups > 0) {
			api.logger?.warn?.(
				{ cleanedUpProcessGroups },
				"Cleaned up stale local-shell command process groups",
			);
		}
		api.onStop(async () => {
			await abortAllActiveLocalShellCommands();
		});
	},
};

export default localShellExtension;
export * from "./command-runner.js";
export * from "./process-definition.js";
export * from "./state.js";
