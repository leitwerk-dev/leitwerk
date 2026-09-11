import type { ProcessLifecycleStatus } from "@leitwerk-dev/domain";
import type { ProcessGraphView } from "@leitwerk-dev/process-sdk";
import type { ProcessTimelineTurnSummary } from "@leitwerk-dev/protocol";

/** Navigation retains human decisions omitted by the business-flow diagram. */
export function presentProcessTurnNavigation(input: {
	graph: ProcessGraphView;
	turns: readonly ProcessTimelineTurnSummary[];
	selectedTurnId: string | null;
	lifecycleStatus: ProcessLifecycleStatus;
}) {
	const path = input.graph.happyPath ?? [];
	const currentIndex = path.indexOf(input.selectedTurnId ?? "");
	const nextId =
		input.lifecycleStatus === "active" && currentIndex >= 0 ? path[currentIndex + 1] : undefined;
	const next = nextId ? input.graph.turns.get(nextId) : undefined;
	return {
		turns: input.turns.map((turn) => ({
			...turn,
			displayTurn: input.graph.turns.get(turn.turnId)?.description.trim() || turn.displayTurn,
		})),
		plannedNextTurn: next && nextId ? { turnId: nextId, description: next.description } : null,
	};
}
