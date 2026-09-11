import type {
	ProcessTimelineTurnPresentation,
	ProcessTimelineTurnSummary,
} from "./http-contracts.js";
import type { PrimaryPathActiveTurnSnapshot } from "./primary-path-snapshot.js";

export function timelinePresentationForTurnType(
	turnType: ProcessTimelineTurnSummary["turnType"],
): ProcessTimelineTurnPresentation {
	if (turnType === "external") return "external_trigger";
	if (turnType === "human") return "operator_decision";
	return turnType === "automatic" ? "automatic_turn" : "llm_turn";
}

export function buildActiveTimelineTurnSummary(
	activeTurn: Pick<
		PrimaryPathActiveTurnSnapshot,
		"turnRecordId" | "turnId" | "turnType" | "pathType" | "startedAt" | "assistant"
	>,
	input: {
		summary: string;
		output: string;
		actionSource?: ProcessTimelineTurnSummary["actionSource"];
	} = { summary: `Current step: ${activeTurn.turnId}`, output: activeTurn.assistant.text.trim() },
): ProcessTimelineTurnSummary {
	return {
		id: activeTurn.turnRecordId,
		turnId: activeTurn.turnId,
		turnType: activeTurn.turnType,
		displayTurn: activeTurn.turnId,
		outcome: "in_progress",
		summary: input.summary,
		output: input.output,
		turnResultMarkdown: "",
		pathType: activeTurn.pathType,
		createdAt: activeTurn.startedAt,
		presentation: timelinePresentationForTurnType(activeTurn.turnType),
		status: "in_progress",
		modelProfileId: null,
		attemptNumber: 1,
		parentTurnRecordId: null,
		startedAt: activeTurn.startedAt,
		endedAt: null,
		actionSource: input.actionSource ?? null,
		progress: null,
	};
}
