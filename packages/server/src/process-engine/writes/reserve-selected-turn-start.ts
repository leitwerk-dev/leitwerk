import type { MappedTurnItemRef, ProcessInstance } from "@leitwerk-dev/domain";
import { generateId } from "../../db/repo-helpers.js";
import { applyProcessPatchField, type Writes } from "./writes.js";

/** Reserves a worker start without creating an attempt; acceptance creates the record. @internal */
export function reserveSelectedTurnStart(
	writes: Writes,
	process: ProcessInstance,
	turnId: string,
	turnType: "llm" | "automatic",
	iteration?: MappedTurnItemRef,
): void {
	const startId = generateId("tsr");
	writes.turnStartWrites.push({
		kind: "create",
		input: {
			id: startId,
			instanceId: process.id,
			turnId,
			turnType,
			proposedTurnRecordId: generateId("trn"),
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state:
				turnType === "automatic"
					? { kind: "starting", start: { kind: "automatic" } }
					: {
							kind: "preparation_failed",
							requestedModelProfileId: process.selectedTurnModelProfileId ?? null,
							providerOptions: {},
							code: "model_required",
							safeSummary: "LLM start requires model preflight",
						},
			...(iteration ? { iteration } : {}),
		},
	});
	applyProcessPatchField(writes, process, "currentExecution", {
		kind: "worker_start",
		id: startId,
	});
	// Model preflight activates LLM starts before the worker can accept them.
	if (turnType === "llm") applyProcessPatchField(writes, process, "lifecycleStatus", "error");
}
