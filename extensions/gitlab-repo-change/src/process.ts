import { createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import type { RepositoryChangePublicationAdapter } from "@leitwerk-dev/coding/repository-change-publication";
import {
	createRepositoryChangePublication,
	type PublicationEvidence,
	type PublicationSource,
	readPublicationState,
} from "@leitwerk-dev/coding/repository-change-publication";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import {
	createGitLabPublicationAdapter,
	type GitLabDeliveryObservation,
	gitlabExternal,
	gitlabIssueWatcherSource,
	gitlabPublicationEvidenceForRequest,
	gitlabPublicationSource,
} from "@leitwerk-dev/gitlab";
import type { ExtensionProcessDefinition, ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import type { createGitLabRepoChangeLauncher } from "./launcher.js";
import { type GitLabRepoChangeParams, gitlabRepoChangeParamsCodec } from "./params.js";

const remote = (state: RepositoryChangeState) => readPublicationState(state, "gitlabRepoChange");
const maintenanceAdapters = new WeakMap<
	ExtensionProcessDefinition<GitLabRepoChangeParams, RepositoryChangeState>,
	RepositoryChangePublicationAdapter<GitLabRepoChangeParams>
>();
/** @internal */
export function registerGitLabRepoChangeMaintenance(
	api: ServerExtensionAPI,
	process: ExtensionProcessDefinition<GitLabRepoChangeParams, RepositoryChangeState>,
): void {
	maintenanceAdapters.get(process)?.maintenance?.register(api, process);
}
function requireRequest(state: RepositoryChangeState) {
	const current = remote(state);
	if (!current.prNumber || !current.headSha)
		throw new Error("Merge request delivery state is incomplete");
	return { ...current, prNumber: current.prNumber, headSha: current.headSha };
}

/** @public */
export function gitlabPublicationEvidence(
	state: RepositoryChangeState,
	event: GitLabDeliveryObservation,
): PublicationEvidence {
	return gitlabPublicationEvidenceForRequest(remote(state), event);
}

/** @public */
export function createGitLabRepoChangeProcess(
	launcher: ReturnType<typeof createGitLabRepoChangeLauncher>,
	docker: boolean,
) {
	const sources: PublicationSource<GitLabRepoChangeParams>[] = [
		{
			id: "gitlab_merge_request",
			kind: "observation",
			label: "GitLab merge request evidence",
			source: gitlabExternal.mergeRequest(({ params, state }) =>
				gitlabPublicationSource(params, remote(state)),
			),
			read: ({ state, event }) =>
				gitlabPublicationEvidence(state, event as GitLabDeliveryObservation),
		},
		{
			id: "source_cancelled",
			kind: "cancelled",
			label: "GitLab source issue cancelled",
			enabled: (params, state) =>
				params.origin === "issue" && !!remote(state).prNumber && !!remote(state).headSha,
			source: gitlabExternal.issueCancelled(({ params, state }) => {
				if (params.origin !== "issue") throw new Error("Missing GitLab source issue");
				return {
					profile: params.gitlabProfile,
					origin: params.gitlabOrigin,
					projectId: params.projectId,
					issueIid: params.issueNumber,
					iid: requireRequest(state).prNumber,
					triggerLabel: params.triggerLabel,
					pollInterval: "30s",
				};
			}),
			read: () => ({ kind: "cancelled" }),
		},
	];
	const adapter = createGitLabPublicationAdapter<GitLabRepoChangeParams>(sources);
	const publication = createRepositoryChangePublication(adapter);
	publication.fragment.watcher({
		id: "use_leitwerk",
		label: "GitLab use-leitwerk issues",
		description: "Launch repository changes from labeled GitLab issues",
		source: gitlabIssueWatcherSource,
		preparationChecks: launcher.preparationChecks,
		resolveLaunchConfig: launcher.fromIssue,
	});
	const definition = createRepositoryChangeProcess<GitLabRepoChangeParams>({
		processId: "gitlab_repo_change_process",
		displayName: "GitLab Repo Change",
		paramsCodec: gitlabRepoChangeParamsCodec,
		launcher: launcher.launcher,
		workflow: launcher.workflow,
		repositoryCredentials: ({ params, projects }) =>
			projects.map((project) => {
				if (!params.gitSshProfile) throw new Error("Missing Git SSH profile");
				return {
					projectKey: project.key,
					kind: "git_ssh" as const,
					credentialRef: params.gitSshProfile,
				};
			}),
		publication,
	});
	definition.process.runtime = { ...definition.process.runtime, docker };
	maintenanceAdapters.set(definition.process, adapter);
	return definition.process;
}
