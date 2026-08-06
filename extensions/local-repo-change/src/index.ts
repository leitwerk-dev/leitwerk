import { coreHostCapabilities, type LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { createLocalRepoChangeAutoWorkBranchCoordinator } from "./auto-work-branch-server.js";
import { localRepoChangeCapabilities, localRepoChangeLaunchPlanner } from "./launch-policy.js";
import { localRepoChangeProcess } from "./process-definition.js";

export const manifest = {
	id: "local-repo-change",
	version: "0.1.0",
} as const;

const localRepoChangeExtension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.provide(localRepoChangeCapabilities.launchPlanner, localRepoChangeLaunchPlanner);
		api.registerProcess(localRepoChangeProcess);
	},
	setupServer(api) {
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) return;
		const autoWorkBranches = createLocalRepoChangeAutoWorkBranchCoordinator({
			commands: deps.commands,
			logger: api.logger,
		});
		api.events.on("process_created", (payload) => {
			void autoWorkBranches.reconcile(payload.process.id, "process_created");
		});
		api.events.on("process_updated", (payload) => {
			if (payload.changedFields.includes("title")) {
				void autoWorkBranches.reconcile(payload.process.id, "title_updated");
			}
		});
		api.onStart(() => autoWorkBranches.reconcileAll());
	},
};

export default localRepoChangeExtension;

export {
	formatLocalRepoChangeLaunchErrors,
	type LocalRepoChangeLaunchPlanner,
	type LocalRepoChangeLaunchPlannerInput,
	type LocalRepoChangeLaunchResolution,
	localRepoChangeCapabilities,
	localRepoChangeImportedPlanLauncherId,
	localRepoChangeLaunchPlanner,
	localRepoChangeProcessId,
	localRepoChangeUiLauncherId,
} from "./launch-policy.js";
export {
	type LocalRepoChangeLaunchKind,
	type LocalRepoChangeParams,
	localRepoChangeParamsCodec,
} from "./params.js";
export { localRepoChangeProcess } from "./process-definition.js";
