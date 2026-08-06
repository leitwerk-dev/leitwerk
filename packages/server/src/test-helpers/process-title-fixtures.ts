import type { ProcessLaunchPlan, ProcessTitleSourceField } from "@leitwerk-dev/process-sdk";

export function createProcessTitleLaunchPlan(
	overrides: Partial<ProcessLaunchPlan> = {},
): ProcessLaunchPlan {
	const titleSourceFields: readonly ProcessTitleSourceField[] = [
		{
			label: "Prompt",
			value: "Implement a collapsible sidebar for the process list.",
		},
	];
	return {
		launcherId: "local_repo_change_process.ui_launcher",
		processId: "local_repo_change_process",
		processInput: {
			processId: "local_repo_change_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			title: null,
			externalId: null,
			externalUrl: null,
			metadata: null,
			defaultModelProfileId: null,
			turnConfigsJson: null,
			selectedTurnModelProfileId: null,
			paramsJson: JSON.stringify({
				repoLocator: "/tmp/repo",
				baseBranch: "main",
				workBranch: "feature/test",
				prompt: "Implement a collapsible sidebar for the process list.",
			}),
			stateJson: "{}",
		},
		titleSourceFields,
		projectInputs: [],
		startTurnId: "generate_plan",
		...overrides,
	};
}
