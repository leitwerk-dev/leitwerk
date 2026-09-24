import { createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import {
	createRepositoryChangePublication,
	publicationObject as object,
	type PublicationSource,
	type PublicationState,
	pullRequestPublicationCallbacks,
	pullRequestPublicationSources,
	readPublicationState,
	reconcilePullRequestSourceIssue,
	resolvePullRequestGitIdentity,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { githubExternal, githubIssueWatcherSource } from "@leitwerk-dev/github";
import type { createGitHubRepoChangeLauncher } from "./launcher.js";
import {
	type GitHubRepoChangeParams,
	githubRepoChangeParamsCodec,
	isIssueOrigin,
} from "./params.js";

const processId = "github_repo_change_process";
const ids = {
	deliver: "deliver_change",
	feedback: "revise_from_pull_request_feedback",
	ciRepair: "repair_github_checks",
	operator: "ci_operator_action",
};
const remote = (state: RepositoryChangeState) => readPublicationState(state, "githubRepoChange");

const deliveryTools = [
	"github_get_pull_request",
	"github_add_pull_request_comment",
	"github_resolve_git_identity",
	"github_ensure_pull_request",
	"github_add_issue_comment",
	"github_add_pull_request_feedback_reaction",
	"github_reply_to_pull_request_feedback",
	"github_get_issue",
	"github_ensure_label",
	"github_update_issue",
] as const;

/** @public */
export function createGitHubRepoChangeProcess(
	launcher: ReturnType<typeof createGitHubRepoChangeLauncher>,
	docker: boolean,
) {
	const sharedSources = pullRequestPublicationSources<GitHubRepoChangeParams>(
		"github",
		"GitHub",
		githubExternal,
		(params) => params.githubProfile,
		(params) => (isIssueOrigin(params) ? params : undefined),
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
		{
			id: "github_merge_conflict",
			kind: "conflict",
			label: "Rebase conflicting pull request",
			source: githubExternal.pullRequestState(({ params, state }) => ({
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
			read: ({ event }) => ({
				kind: "conflict",
				conflict: object(event).conflict as NonNullable<PublicationState["conflict"]>,
			}),
		},
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
	const publicationConfig = createRepositoryChangePublication<GitHubRepoChangeParams>({
		namespace: "githubRepoChange",
		label: "GitHub PR",
		ids,
		sources,
		tools: {
			delivery: deliveryTools,
			feedback: ["github_get_pull_request", "github_list_pull_request_feedback"],
			ci: ["github_get_ci_diagnostics"],
		},
		identity: (ctx) => resolvePullRequestGitIdentity(ctx, "github", ctx.params.githubProfile),
		reconcileTerminal: reconcilePullRequestSourceIssue<GitHubRepoChangeParams>(
			"github",
			"name",
			(params) => (isIssueOrigin(params) ? params : undefined),
		),
		...pullRequestPublicationCallbacks<GitHubRepoChangeParams>("github", "GitHub", (params) =>
			isIssueOrigin(params) ? params : undefined,
		),
		commitMessage: (kind) =>
			kind === "feedback" ? "fix: address GitHub review feedback" : "fix: repair GitHub checks",
		prompt(kind, current) {
			return kind === "feedback"
				? `Address the unseen GitHub pull-request feedback batch for PR #${current.prNumber}. Feedback identifiers: ${JSON.stringify(current.feedbackIds)}. Inspect the current checkout and use GitHub tools to read the full feedback. Do not rely on an earlier plan or conversation. Make only justified repository changes. Call changes_ready if files need publishing, no_changes after an explicit diagnosis that no repository change is needed, or cannot_repair when operator action is required.`
				: `Diagnose failed GitHub checks for request #${current.prNumber}, head ${current.headSha}. Use github_get_ci_diagnostics with pullRequestNumber and headSha to inspect failed check annotations and bounded Actions job logs before changing anything. Fix repository causes. Call changes_ready for repository changes, no_changes only after an explicit provider restart or a justified diagnosis that no repository change is needed, or cannot_repair when operator action is required.`;
		},
	});
	const publication = publicationConfig.fragment;
	publication.watcher({
		id: "use_leitwerk",
		label: "GitHub use-leitwerk issues",
		description: "Launch a remote repository change for GitHub issues carrying the trigger label",
		source: githubIssueWatcherSource,
		preparationChecks: launcher.preparationChecks,
		resolveLaunchConfig: launcher.launcher.resolveIssueLaunchConfig,
	});

	const definition = createRepositoryChangeProcess<GitHubRepoChangeParams>({
		processId,
		displayName: "GitHub Repo Change",
		paramsCodec: githubRepoChangeParamsCodec,
		launcher: launcher.launcher,
		finalizeLabel: "Publish pull request",
		finalizeForm: {
			id: "github_publish",
			title: "Publish pull request",
			fields: [],
			submitLabel: "Publish",
		},
		repositoryCredentials: ({ params }) => [
			{
				projectKey: "repo",
				kind: "git_ssh",
				credentialRef: params.sshCredentialRef,
			},
		],
		publication: publicationConfig,
	});

	definition.process.runtime = { ...definition.process.runtime, docker };

	return definition.process;
}
