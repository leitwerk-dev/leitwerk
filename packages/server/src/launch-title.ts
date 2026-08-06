import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";

export const MAX_PROCESS_TITLE_LENGTH = 80;

export interface SubmittedProcessTitleInput {
	title: string | null;
	titleProvided: boolean;
}

export function truncateTextAtWordBoundary(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value;
	}
	const sliced = value.slice(0, Math.max(1, maxLength - 1)).trimEnd();
	const lastWhitespace = sliced.lastIndexOf(" ");
	const base =
		lastWhitespace >= Math.floor(maxLength * 0.6) ? sliced.slice(0, lastWhitespace) : sliced;
	return `${base.trimEnd()}…`;
}

export function normalizeProcessTitleInput(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return null;
	}
	return truncateTextAtWordBoundary(trimmed.replace(/\s+/g, " "), MAX_PROCESS_TITLE_LENGTH);
}

export function normalizeSubmittedProcessTitle(value: unknown): string | null {
	return typeof value === "string" ? normalizeProcessTitleInput(value) : null;
}

export function applySubmittedProcessTitleToLaunchPlan(
	launchPlan: ProcessLaunchPlan,
	input: SubmittedProcessTitleInput,
): ProcessLaunchPlan {
	if (!input.titleProvided) {
		return launchPlan;
	}
	return {
		...launchPlan,
		processInput: {
			...launchPlan.processInput,
			title: input.title,
		},
	};
}
