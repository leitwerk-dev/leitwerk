import { createFinalizeChangeForm, createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import { createRepositoryChangeUiLauncher } from "@leitwerk-dev/coding/repository-change-launch";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import { remoteRepoChangeLaunchPlanner, remoteRepoChangeUiLauncherId } from "./launch-policy.js";
import { type RemoteRepoChangeParams, remoteRepoChangeParamsCodec } from "./params.js";

const launcher = createRepositoryChangeUiLauncher<RemoteRepoChangeParams>({
	id: remoteRepoChangeUiLauncherId,
	formId: "remote_repo_change_form",
	title: "Remote Repo Change",
	sshCredentials: true,
	workBranchDescription:
		"Optional. Leave blank to derive one from the requested change and repository identity without preflight remote access.",
	resolveLaunchConfig: (input) =>
		remoteRepoChangeLaunchPlanner.plan({
			input: { ...input, launchKind: "requested_change" },
		}),
});

const definition = createRepositoryChangeProcess({
	processId: "remote_repo_change_process",
	displayName: "Remote Repo Change",
	paramsCodec: remoteRepoChangeParamsCodec,
	launcher,
	finalizeLabel: "Push change",
	finalizeForm: createFinalizeChangeForm({ title: "Push change" }),
	finalizationDescription: "Commit and push",
	repositoryCredentials: ({ params }) => [
		{ projectKey: "repo", kind: "git_ssh", credentialRef: params.sshCredentialRef },
	],
});

/** @internal */
export const remoteRepoChangeProcess: ExtensionProcessDefinition<
	RemoteRepoChangeParams,
	RepositoryChangeState
> = definition.process;
export const planDecision = definition.planDecision;
export const planReviewFeedback = definition.planReviewFeedback;
export const implementationDecision = definition.implementationDecision;
export const implementationReviewFeedback = definition.implementationReviewFeedback;
export const simplificationDecision = definition.simplificationDecision;
