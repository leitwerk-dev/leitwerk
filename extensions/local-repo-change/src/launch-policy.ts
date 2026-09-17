import {
	createRepositoryChangeLaunchPlanner,
	formatRepositoryChangeLaunchErrors,
	type RepositoryChangeLaunchPlannerInput,
	type RepositoryChangeLaunchResolution,
} from "@leitwerk-dev/coding/repository-change-launch";
import { createCapabilityToken } from "@leitwerk-dev/process-sdk";
import { type LocalRepoChangeParams, normalizeLocalRepoChangeParamsInput } from "./params.js";

/** @internal */
export const localRepoChangeProcessId = "local_repo_change_process" as const;
/** @internal */
export const localRepoChangeUiLauncherId = "local_repo_change_process.ui_launcher" as const;
/** @internal */
export const localRepoChangeImportedPlanLauncherId =
	"local_repo_change_process.imported_plan" as const;

/** @internal */
export type LocalRepoChangeLaunchPlannerInput = RepositoryChangeLaunchPlannerInput;
/** @internal */
export type LocalRepoChangeLaunchResolution =
	RepositoryChangeLaunchResolution<LocalRepoChangeParams>;
/** @internal */
export interface LocalRepoChangeLaunchPlanner {
	/** @internal */
	plan(input: LocalRepoChangeLaunchPlannerInput): LocalRepoChangeLaunchResolution;
}

/** @internal */
export const formatLocalRepoChangeLaunchErrors = formatRepositoryChangeLaunchErrors;

/** @internal */
export const localRepoChangeCapabilities = {
	/** @internal */
	launchPlanner: createCapabilityToken<LocalRepoChangeLaunchPlanner>(
		"local-repo-change:launch-planner",
	),
} as const;

function paramsFromInput(input: Record<string, unknown>): LocalRepoChangeParams {
	const { importedPlanMarkdown, ...shared } = normalizeLocalRepoChangeParamsInput(input);
	return (
		shared.launchKind === "imported_plan"
			? { ...shared, launchKind: "imported_plan", importedPlanMarkdown }
			: { ...shared, launchKind: shared.launchKind }
	) as LocalRepoChangeParams;
}

/** @internal */
export const localRepoChangeLaunchPlanner: LocalRepoChangeLaunchPlanner =
	createRepositoryChangeLaunchPlanner({
		processId: localRepoChangeProcessId,
		normalize: paramsFromInput,
		validateRepoLocator: (locator) =>
			locator ? null : "repoLocator must be a local filesystem path or remote git URL",
		deferWithoutWorkBranch: true,
	}) satisfies LocalRepoChangeLaunchPlanner;
