import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { remoteRepoChangeCapabilities, remoteRepoChangeLaunchPlanner } from "./launch-policy.js";
import { remoteRepoChangeProcess } from "./process-definition.js";

export const manifest = {
	id: "remote-repo-change",
	version: "0.1.0",
	requires: ["coding", "git-ssh"],
} as const;

const remoteRepoChangeExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.provide(remoteRepoChangeCapabilities.launchPlanner, remoteRepoChangeLaunchPlanner);
		api.registerProcess(remoteRepoChangeProcess);
	},
};

export default remoteRepoChangeExtension;

export {
	type RemoteRepoChangeLaunchPlanner,
	type RemoteRepoChangeLaunchPlannerInput,
	type RemoteRepoChangeLaunchResolution,
	remoteRepoChangeCapabilities,
	remoteRepoChangeImportedPlanLauncherId,
	remoteRepoChangeLaunchPlanner,
	remoteRepoChangeProcessId,
	remoteRepoChangeUiLauncherId,
} from "./launch-policy.js";
export {
	type RemoteRepoChangeLaunchKind,
	type RemoteRepoChangeParams,
	remoteRepoChangeParamsCodec,
} from "./params.js";
export { remoteRepoChangeProcess } from "./process-definition.js";
