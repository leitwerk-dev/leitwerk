import { buildAutoWorkBranchFromSeed } from "@leitwerk-dev/coding/auto-work-branch";
import {
	createRepositoryChangeLaunchPlanner,
	type RepositoryChangeLaunchPlannerInput,
	type RepositoryChangeLaunchResolution,
} from "@leitwerk-dev/coding/repository-change-launch";
import { createCapabilityToken, type LauncherValidationError } from "@leitwerk-dev/process-sdk";
import { normalizeRemoteRepoChangeParamsInput, type RemoteRepoChangeParams } from "./params.js";

/** @internal */
export const remoteRepoChangeProcessId = "remote_repo_change_process" as const;
/** @internal */
export const remoteRepoChangeUiLauncherId = "remote_repo_change_process.ui_launcher" as const;
/** @internal */
export const remoteRepoChangeImportedPlanLauncherId =
	"remote_repo_change_process.imported_plan" as const;

/** @internal */
export type RemoteRepoChangeLaunchPlannerInput = RepositoryChangeLaunchPlannerInput;
/** @internal */
export type RemoteRepoChangeLaunchResolution =
	RepositoryChangeLaunchResolution<RemoteRepoChangeParams>;
/** @internal */
export interface RemoteRepoChangeLaunchPlanner {
	/** @internal */
	plan(input: RemoteRepoChangeLaunchPlannerInput): RemoteRepoChangeLaunchResolution;
}

/** @internal */
export const remoteRepoChangeCapabilities = {
	/** @internal */
	launchPlanner: createCapabilityToken<RemoteRepoChangeLaunchPlanner>(
		"remote-repo-change:launch-planner",
	),
} as const;

function isSshLocator(value: string): boolean {
	if (/^ssh:\/\//i.test(value)) {
		try {
			const url = new URL(value);
			return Boolean(url.hostname) && !url.password;
		} catch {
			return false;
		}
	}
	return /^[^/@:\s]+@[^/:\s]+:.+/.test(value);
}

function paramsFromInput(input: Record<string, unknown>): RemoteRepoChangeParams {
	const { importedPlanMarkdown, ...shared } = normalizeRemoteRepoChangeParamsInput(input);
	return (
		shared.launchKind === "imported_plan"
			? { ...shared, launchKind: "imported_plan", importedPlanMarkdown }
			: { ...shared, launchKind: shared.launchKind }
	) as RemoteRepoChangeParams;
}

/** @internal */
export const remoteRepoChangeLaunchPlanner: RemoteRepoChangeLaunchPlanner =
	createRepositoryChangeLaunchPlanner({
		processId: remoteRepoChangeProcessId,
		normalize: paramsFromInput,
		validateRepoLocator: (locator) =>
			isSshLocator(locator)
				? null
				: "repoLocator must be an SSH URL or user@host:path locator without embedded credentials",
		validate: (_input, params): LauncherValidationError[] =>
			params.sshCredentialRef
				? []
				: [
						{
							code: "required",
							fieldId: "sshCredentialRef",
							message: "sshCredentialRef is required",
						},
					],
		prepare: (params) =>
			params.workBranch
				? params
				: {
						...params,
						workBranch: buildAutoWorkBranchFromSeed(
							params.prompt,
							`${params.repoLocator}:${params.baseBranch}`,
						),
					},
	}) satisfies RemoteRepoChangeLaunchPlanner;
