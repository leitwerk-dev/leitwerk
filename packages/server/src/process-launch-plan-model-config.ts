import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";

export function clearLaunchPlanModelConfig(launchPlan: ProcessLaunchPlan): ProcessLaunchPlan {
	return {
		...launchPlan,
		processInput: {
			...launchPlan.processInput,
			defaultModelProfileId: null,
			turnConfigsJson: null,
		},
	};
}

export function applyStoredLaunchPlanModelConfig(
	launchPlan: ProcessLaunchPlan,
	storedProcessInput: Pick<
		ProcessLaunchPlan["processInput"],
		"defaultModelProfileId" | "turnConfigsJson"
	>,
): ProcessLaunchPlan {
	const defaultModelProfileId = storedProcessInput.defaultModelProfileId ?? null;
	return {
		...launchPlan,
		processInput: {
			...launchPlan.processInput,
			defaultModelProfileId,
			turnConfigsJson: storedProcessInput.turnConfigsJson ?? null,
		},
	};
}
