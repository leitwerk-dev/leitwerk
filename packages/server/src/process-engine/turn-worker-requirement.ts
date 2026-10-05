import { isWorkerOwnedTurnType, type ProcessInstance } from "@leitwerk-dev/domain";
import type { ProcessGraphRegistry } from "../process-graph.js";
import { pendingTurnWait } from "./turn-wait-state.js";

type ProcessWorkerRequirementInput = Pick<ProcessInstance, "selectedTurnId" | "lifecycleStatus"> & {
	processId?: string | null;
	metadata?: ProcessInstance["metadata"];
	currentExecution?: ProcessInstance["currentExecution"];
};

export function selectedTurnRequiresWorker(
	processGraphs: ProcessGraphRegistry | undefined,
	process: ProcessWorkerRequirementInput,
): boolean {
	if (!process.selectedTurnId || process.lifecycleStatus !== "active") {
		return false;
	}
	if (pendingTurnWait({ metadata: process.metadata ?? null })) return false;
	const turn = process.processId
		? processGraphs?.get(process.processId)?.turns.get(process.selectedTurnId)?.definition
		: undefined;
	return turn ? isWorkerOwnedTurnType(turn.kind) : true;
}
