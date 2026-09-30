import {
	createPullRequestChangeProcess,
	publicationObject as object,
	type PublicationSource,
	type PublicationState,
	pullRequestPublicationDefaults,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { forgejoExternal, forgejoIssueWatcherSource } from "@leitwerk-dev/forgejo";
import { woodpeckerExternal } from "@leitwerk-dev/woodpecker";
import type { createForgejoRepoChangeLauncher } from "./launcher.js";
import {
	type ForgejoRepoChangeParams,
	forgejoRepoChangeParamsCodec,
	isIssueOrigin,
} from "./params.js";

const remote = (state: RepositoryChangeState) => readPublicationState(state, "forgejoRepoChange");

/** @internal */
export function createForgejoRepoChangeProcess(
	launcher: ReturnType<typeof createForgejoRepoChangeLauncher>,
	docker: boolean,
) {
	const sharedSources = pullRequestPublicationDefaults<ForgejoRepoChangeParams>(
		"forgejo",
		"Forgejo",
		forgejoExternal,
		(params) => params.forgejoProfile,
		(params) => (isIssueOrigin(params) ? params : undefined),
		"id",
		{
			id: "repair_woodpecker_pipeline",
			label: "Woodpecker pipeline",
			tools: [
				"woodpecker_lookup_repository",
				"woodpecker_list_pipelines",
				"woodpecker_get_pipeline",
				"woodpecker_get_step_logs",
				"woodpecker_restart_pipeline",
			],
			prompt: (current) =>
				`Diagnose Woodpecker pipeline #${current.pipeline?.number ?? "unknown"} (${current.pipeline?.status ?? "unknown"}) for the current checkout. Use Woodpecker tools to inspect pipeline metadata and bounded failed-step logs before changing anything. Fix repository causes. Call changes_ready for repository changes, no_changes only after an explicit provider restart or a justified diagnosis that no repository change is needed, or cannot_repair when operator action is required.`,
		},
	);
	const { requirePr } = sharedSources;
	const failedPipeline = woodpeckerExternal.pipeline<
		ForgejoRepoChangeParams,
		RepositoryChangeState
	>(({ params, state }) => {
		const current = requirePr(state);
		return {
			profile: params.woodpeckerProfile,
			owner: params.owner,
			repo: params.repo,
			branch: params.workBranch,
			headSha: current.headSha,
			afterPipelineNumber: current.pipeline?.number ?? 0,
			statuses: ["failure", "error", "killed", "canceled", "cancelled", "declined", "blocked"],
			pollInterval: "30s",
		};
	});

	const sources: PublicationSource<ForgejoRepoChangeParams>[] = [
		sharedSources.conflict(
			forgejoExternal.pullRequestConflict(({ params, state }) => ({
				profile: params.forgejoProfile,
				owner: params.owner,
				repo: params.repo,
				prNumber: requirePr(state).prNumber,
				headSha: requirePr(state).headSha,
				lastConflictKey: remote(state).lastConflictKey,
				pollInterval: "30s",
			})),
		),
		sharedSources.feedback,
		{
			id: "woodpecker_failure_repair",
			operatorId: "woodpecker_failure_operator",
			kind: "failure",
			label: "Repair failed Woodpecker pipeline",
			source: failedPipeline,
			read: ({ event }) => ({
				kind: "failure",
				pipeline: object(event).pipeline as NonNullable<PublicationState["pipeline"]>,
			}),
		},
		...sharedSources.terminal,
		sharedSources.cancelled,
	];
	return createPullRequestChangeProcess("forgejo", "Forgejo", docker, {
		paramsCodec: forgejoRepoChangeParamsCodec,
		launcher: launcher.launcher,
		workflow: launcher.workflow,
		publication: { ...sharedSources.adapter, sources },
		watcher: {
			source: forgejoIssueWatcherSource,
			preparationChecks: launcher.preparationChecks,
			resolveLaunchConfig: launcher.launcher.resolveIssueLaunchConfig,
		},
	});
}
