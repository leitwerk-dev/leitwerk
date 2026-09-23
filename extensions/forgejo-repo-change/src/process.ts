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
import { forgejoExternal, forgejoIssueWatcherSource } from "@leitwerk-dev/forgejo";
import { woodpeckerExternal } from "@leitwerk-dev/woodpecker";
import {
	type createForgejoRepoChangeLauncher,
	forgejoRepoChangeLaunchConfig,
	forgejoRepoChangeParams,
} from "./launcher.js";
import {
	type ForgejoRepoChangeParams,
	forgejoRepoChangeParamsCodec,
	isIssueOrigin,
} from "./params.js";

const processId = "forgejo_repo_change_process";
const ids = {
	deliver: "deliver_change",
	feedback: "revise_from_pull_request_feedback",
	ciRepair: "repair_woodpecker_pipeline",
	operator: "ci_operator_action",
};
const remote = (state: RepositoryChangeState) => readPublicationState(state, "forgejoRepoChange");

const deliveryTools = [
	"forgejo_get_pull_request",
	"forgejo_add_pull_request_comment",
	"forgejo_resolve_git_identity",
	"forgejo_ensure_pull_request",
	"forgejo_add_issue_comment",
	"forgejo_add_pull_request_feedback_reaction",
	"forgejo_reply_to_pull_request_feedback",
	"forgejo_get_issue",
	"forgejo_ensure_label",
	"forgejo_update_issue",
] as const;

/** @internal */
export function createForgejoRepoChangeProcess(
	launcher: ReturnType<typeof createForgejoRepoChangeLauncher>,
	docker: boolean,
) {
	const sharedSources = pullRequestPublicationSources<ForgejoRepoChangeParams>(
		"forgejo",
		"Forgejo",
		forgejoExternal,
		(params) => params.forgejoProfile,
		(params) => (isIssueOrigin(params) ? params : undefined),
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
		{
			id: "forgejo_merge_conflict",
			kind: "conflict",
			label: "Rebase conflicting pull request",
			source: forgejoExternal.pullRequestConflict(({ params, state }) => ({
				profile: params.forgejoProfile,
				owner: params.owner,
				repo: params.repo,
				prNumber: requirePr(state).prNumber,
				headSha: requirePr(state).headSha,
				lastConflictKey: remote(state).lastConflictKey,
				pollInterval: "30s",
			})),
			read: ({ event }) => ({
				kind: "conflict",
				conflict: object(event).conflict as NonNullable<PublicationState["conflict"]>,
			}),
		},
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
	const publicationConfig = createRepositoryChangePublication<ForgejoRepoChangeParams>({
		namespace: "forgejoRepoChange",
		label: "Forgejo PR",
		ids,
		sources,
		tools: {
			delivery: deliveryTools,
			feedback: ["forgejo_get_pull_request", "forgejo_list_pull_request_feedback"],
			ci: [
				"woodpecker_lookup_repository",
				"woodpecker_list_pipelines",
				"woodpecker_get_pipeline",
				"woodpecker_get_step_logs",
				"woodpecker_restart_pipeline",
			],
		},
		identity: (ctx) => resolvePullRequestGitIdentity(ctx, "forgejo", ctx.params.forgejoProfile),
		reconcileTerminal: reconcilePullRequestSourceIssue<ForgejoRepoChangeParams>(
			"forgejo",
			"id",
			(params) => (isIssueOrigin(params) ? params : undefined),
		),
		...pullRequestPublicationCallbacks<ForgejoRepoChangeParams>("forgejo", "Forgejo", (params) =>
			isIssueOrigin(params) ? params : undefined,
		),
		commitMessage: (kind) =>
			kind === "feedback"
				? "fix: address Forgejo review feedback"
				: "fix: repair Woodpecker pipeline",
		prompt(kind, current) {
			return kind === "feedback"
				? `Address the unseen Forgejo pull-request feedback batch for PR #${current.prNumber}. Feedback identifiers: ${JSON.stringify(current.feedbackIds)}. Inspect the current checkout and use Forgejo tools to read the full feedback. Do not rely on an earlier plan or conversation. Make only justified repository changes. Call changes_ready if files need publishing, no_changes after an explicit diagnosis that no repository change is needed, or cannot_repair when operator action is required.`
				: `Diagnose Woodpecker pipeline #${current.pipeline?.number ?? "unknown"} (${current.pipeline?.status ?? "unknown"}) for the current checkout. Use Woodpecker tools to inspect pipeline metadata and bounded failed-step logs before changing anything. Fix repository causes. Call changes_ready for repository changes, no_changes only after an explicit provider restart or a justified diagnosis that no repository change is needed, or cannot_repair when operator action is required.`;
		},
	});
	const publication = publicationConfig.fragment;
	publication.watcher({
		id: "use_leitwerk",
		label: "Forgejo use-leitwerk issues",
		description: "Launch a remote repository change for Forgejo issues carrying the trigger label",
		source: forgejoIssueWatcherSource,
		preparationChecks: launcher.preparationChecks,
		async resolveLaunchConfig({ profile, repository, issue, labels }) {
			const issueNumber = issue.number;
			const title = issue.title.trim();
			const body = issue.body?.trim() ?? "";
			const issueUrl = issue.html_url;
			const binding = launcher.resolveProfiles(profile);
			const gitIdentity = await launcher.resolveGitIdentity(profile);
			const params: ForgejoRepoChangeParams = {
				...forgejoRepoChangeParams(repository, {
					...binding,
					profile,
					workBranch: `leitwerk/issue-${issueNumber}`,
					prompt: `${title}${body ? `\n\n${body}` : ""}`,
				}),
				origin: "issue",
				issueNumber,
				issueUrl,
				triggerLabel: labels.trigger,
				doneLabel: labels.done,
			};
			return forgejoRepoChangeLaunchConfig(params, title, gitIdentity);
		},
	});

	const definition = createRepositoryChangeProcess<ForgejoRepoChangeParams>({
		processId,
		displayName: "Forgejo Repo Change",
		paramsCodec: forgejoRepoChangeParamsCodec,
		launcher: launcher.launcher,
		finalizeLabel: "Publish pull request",
		finalizeForm: {
			id: "forgejo_publish",
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
