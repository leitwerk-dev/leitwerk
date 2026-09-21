import { codingActionIds, createRepositoryChangeProcess } from "@leitwerk-dev/coding";
import { commitAndPushWorkBranch } from "@leitwerk-dev/coding/finalization-git";
import {
	createRepositoryChangeParamsCodec,
	normalizeRepositoryChangeParamsInput,
	type RepositoryChangeLaunchParams,
} from "@leitwerk-dev/coding/repository-change-launch";
import type { RepositoryChangeState } from "@leitwerk-dev/coding/repository-change-state";
import { flow } from "@leitwerk-dev/process-sdk";

export const sandboxRepositoryChangeProcessId = "sandbox_repository_change_process";
export type SandboxRepositoryChangeParams = RepositoryChangeLaunchParams;

const paramsCodec = createRepositoryChangeParamsCodec<SandboxRepositoryChangeParams>({
	normalize: (value) => normalizeRepositoryChangeParamsInput(value, "Sandbox Repository Change"),
});

const publishTurnId = "publish_work_branch";
const publication = flow.fragment<SandboxRepositoryChangeParams, RepositoryChangeState>(
	"sandbox-publication",
);
publication.turn(
	flow
		.automatic<SandboxRepositoryChangeParams, RepositoryChangeState>(publishTurnId)
		.description("Publish feature branch")
		.run((ctx) => {
			const repo = ctx.repo.get("repo");
			const published = commitAndPushWorkBranch({
				repoPath: repo.fsPath,
				workBranch: repo.workBranch,
				commitMessage: ctx.state.finalization.generatedCommitMessage ?? "",
				gitIdentity: { name: "Sandbox Developer", email: "developer@sandbox.invalid" },
			});
			return { outcome: "published", params: published };
		})
		.outcome("published", (outcome) =>
			outcome
				.description("Feature branch published")
				.requiredString("headSha", "Published feature-branch HEAD")
				.requiredString("pushTarget", "Published remote branch")
				.complete(),
		),
);

export const sandboxRepositoryChangeProcess = createRepositoryChangeProcess({
	processId: sandboxRepositoryChangeProcessId,
	displayName: "Sandbox Repository Change",
	paramsCodec,
	finalizeLabel: "Publish change",
	finalizeForm: {
		id: codingActionIds.finalizeChange,
		title: "Publish change",
		fields: [],
		submitLabel: "Publish change",
	},
	publication: { entryTurnId: publishTurnId, fragment: publication, happyPath: [publishTurnId] },
}).process;
