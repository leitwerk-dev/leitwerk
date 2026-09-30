import {
	createPullRequestChangeProcess,
	publicationObject as object,
	type PublicationSource,
	pullRequestPublicationDefaults,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { githubExternal, githubIssueWatcherSource } from "@leitwerk-dev/github";
import type { createGitHubRepoChangeLauncher } from "./launcher.js";
import {
	type GitHubRepoChangeParams,
	githubRepoChangeParamsCodec,
	isIssueOrigin,
} from "./params.js";

const remote = (state: RepositoryChangeState) => readPublicationState(state, "githubRepoChange");

/** @public */
export function createGitHubRepoChangeProcess(
	launcher: ReturnType<typeof createGitHubRepoChangeLauncher>,
	docker: boolean,
) {
	const sharedSources = pullRequestPublicationDefaults<GitHubRepoChangeParams>(
		"github",
		"GitHub",
		githubExternal,
		(params) => params.githubProfile,
		(params) => (isIssueOrigin(params) ? params : undefined),
		"name",
		{
			id: "repair_github_checks",
			label: "GitHub checks",
			tools: ["github_get_ci_diagnostics"],
			prompt: (current) =>
				`Diagnose failed GitHub checks for request #${current.prNumber}, head ${current.headSha}. Use github_get_ci_diagnostics with pullRequestNumber and headSha to inspect failed check annotations and bounded Actions job logs before changing anything. Fix repository causes. Call changes_ready for repository changes, no_changes only after an explicit provider restart or a justified diagnosis that no repository change is needed, or cannot_repair when operator action is required.`,
		},
	);
	const { requirePr } = sharedSources;
	const failedPipeline = githubExternal.checks<GitHubRepoChangeParams, RepositoryChangeState>(
		({ params, state }) => ({
			profile: params.githubProfile,
			owner: params.owner,
			repo: params.repo,
			prNumber: requirePr(state).prNumber,
			headSha: requirePr(state).headSha,
			afterKey: remote(state).pipeline?.evidenceKey as string | undefined,
		}),
	);

	const sources: PublicationSource<GitHubRepoChangeParams>[] = [
		sharedSources.conflict(
			githubExternal.pullRequestState(({ params, state }) => ({
				profile: params.githubProfile,
				owner: params.owner,
				repo: params.repo,
				prNumber: requirePr(state).prNumber,
				headSha: requirePr(state).headSha,
				lastConflictKey: remote(state).lastConflictKey,
				feedbackCursor: 0,
				eventKinds: ["merge_conflict"],
				pollInterval: "30s",
			})),
		),
		sharedSources.feedback,
		{
			id: "github_failure_repair",
			operatorId: "github_failure_operator",
			kind: "failure",
			label: "Repair failed GitHub checks",
			source: failedPipeline,
			read: ({ state, event }) => {
				const checks = object(object(event).checks);
				const current = requirePr(state);
				if (checks.headSha !== current.headSha) throw new Error("Stale GitHub check evidence");
				const failed = Array.isArray(checks.failed) ? checks.failed : [];
				return {
					kind: "failure",
					pipeline: {
						number: 0,
						status: "failure",
						...checks,
						evidenceKey: `${checks.headSha}:${failed.map((run) => object(run).url).join(":")}`,
					},
				};
			},
		},
		...sharedSources.terminal,
		sharedSources.cancelled,
	];
	return createPullRequestChangeProcess("github", "GitHub", docker, {
		paramsCodec: githubRepoChangeParamsCodec,
		launcher: launcher.launcher,
		workflow: launcher.workflow,
		publication: { ...sharedSources.adapter, sources },
		watcher: {
			source: githubIssueWatcherSource,
			preparationChecks: launcher.preparationChecks,
			resolveLaunchConfig: launcher.launcher.resolveIssueLaunchConfig,
		},
	});
}
