import type { ProcessTurnOutcomeEvent } from "./extension-api.js";
import type {
	PlanSavedEvent,
	ReviewCompletedEvent,
	ReviewRequestedEvent,
} from "./server-events.js";

/** @internal */
export function filterStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

function normalizeMessage(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function resolveOutcomeMarkdown(
	event: Pick<ProcessTurnOutcomeEvent, "params" | "turnResultMarkdown">,
	paramKey: string,
): string | undefined {
	if (typeof event.turnResultMarkdown === "string") {
		return event.turnResultMarkdown;
	}
	const value = event.params[paramKey];
	return typeof value === "string" ? value : undefined;
}

/** @internal */
export function buildPlanSavedEventPayload(input: {
	/** @internal */
	planRevision: number;
	/** @internal */
	event: Pick<ProcessTurnOutcomeEvent, "params" | "turnResultMarkdown">;
}): Omit<PlanSavedEvent, "instanceId"> {
	return {
		planRevision: input.planRevision,
		summary: normalizeMessage(input.event.params.summary),
		planMarkdown: resolveOutcomeMarkdown(input.event, "planMarkdown") ?? "",
		acceptanceCriteria: filterStringArray(input.event.params.acceptanceCriteria),
	};
}

/** @internal */
export function buildReviewRequestedEventPayload(
	event: Pick<ProcessTurnOutcomeEvent, "params">,
): Omit<ReviewRequestedEvent, "instanceId"> {
	return {
		changedProjects: filterStringArray(event.params.changedProjects),
	};
}

/** @internal */
export function buildReviewCompletedEventPayload(
	event: Pick<ProcessTurnOutcomeEvent, "outcome" | "params" | "turnResultMarkdown">,
): Omit<ReviewCompletedEvent, "instanceId"> {
	if (event.outcome === "issues_found") {
		return {
			hasIssues: true,
			issueCount: typeof event.params.issueCount === "number" ? event.params.issueCount : 1,
			...(resolveOutcomeMarkdown(event, "reviewMarkdown")
				? { reviewMarkdown: resolveOutcomeMarkdown(event, "reviewMarkdown") }
				: {}),
		};
	}

	return {
		hasIssues: false,
		issueCount: 0,
	};
}
