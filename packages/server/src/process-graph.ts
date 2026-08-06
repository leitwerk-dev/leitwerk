import type { ProcessFlowView } from "@leitwerk-dev/domain";
import {
	buildProcessFlowView,
	getProcessGraph,
	type ProcessGraphRegistry,
} from "@leitwerk-dev/process-sdk";

export {
	getAllProcessGraphs,
	getProcessGraph,
	getProcessTurnGraph,
	getReachableTurnIdsForProcessGraph,
	getTurnTransitionsForProcessGraph,
	hasProcessGraph,
	isTurnAvailableForProcessGraph,
	listLlmTurnIdsForProcessGraph,
	type ProcessGraphRegistry,
	type ProcessGraphTurnView,
	type ProcessGraphView,
	serializeProcessGraph,
	toProcessGraphView,
	validateProcessGraphEntryTurns,
	validateProcessGraphProducts,
	validateProcessGraphTurnTransitions,
} from "@leitwerk-dev/process-sdk";

/** Build the spine-first flow view for a process from the graph registry. */
export function buildProcessFlowViewForProcess(
	registry: ProcessGraphRegistry,
	processId: string,
): ProcessFlowView {
	return buildProcessFlowView(getProcessGraph(registry, processId));
}
