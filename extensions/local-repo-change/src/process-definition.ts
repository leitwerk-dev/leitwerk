import { createFinalizeChangeForm, createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import { createRepositoryChangeUiLauncher } from "@leitwerk-dev/coding/repository-change-launch";
import { localRepoChangeLaunchPlanner, localRepoChangeUiLauncherId } from "./launch-policy.js";
import { type LocalRepoChangeParams, localRepoChangeParamsCodec } from "./params.js";

const launcher = createRepositoryChangeUiLauncher<LocalRepoChangeParams>({
	id: localRepoChangeUiLauncherId,
	formId: "local_repo_change_form",
	title: "Local Repo Change",
	workBranchDescription:
		"Optional. Leave blank to derive one from the process title and base branch SHA, with a prompt fallback if no title becomes available.",
	resolveRelaunchInput: (previousInput) => ({ ...previousInput, workBranch: "" }),
	resolveLaunchConfig: (input) =>
		localRepoChangeLaunchPlanner.plan({
			input: { ...input, launchKind: "requested_change" },
		}),
});

const definition = createRepositoryChangeProcess({
	processId: "local_repo_change_process",
	displayName: "Local Repo Change",
	paramsCodec: localRepoChangeParamsCodec,
	launcher,
	finalizeLabel: "Merge change",
	finalizeForm: createFinalizeChangeForm({ title: "Merge change" }),
	finalizationDescription: "Commit and merge",
});

export const localRepoChangeProcess = definition.process;
export const planDecision = definition.planDecision;
export const planReviewFeedback = definition.planReviewFeedback;
export const implementationDecision = definition.implementationDecision;
export const implementationReviewFeedback = definition.implementationReviewFeedback;
export const simplificationDecision = definition.simplificationDecision;
