import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { remoteRepoChangeCapabilities, remoteRepoChangeLaunchPlanner } from "./launch-policy.js";
import { remoteRepoChangeProcess } from "./process-definition.js";

/** @internal */
export const manifest = {
	/** @internal */
	id: "remote-repo-change",
	/** @internal */
	version: "0.1.0",
	/** @internal */
	requires: ["coding", "git-ssh"],
} as const;

/** @internal */
const remoteRepoChangeExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.provide(remoteRepoChangeCapabilities.launchPlanner, remoteRepoChangeLaunchPlanner);
		api.registerProcess(remoteRepoChangeProcess);
	},
};

export default remoteRepoChangeExtension;
