import type { ProcessInstance, ProcessTurnRecord, TurnStartRecord } from "@leitwerk-dev/domain";
import { generateId } from "../../db/repo-helpers.js";
import { applyProcessPatchField, createWrites, type Writes } from "./writes.js";

/** @internal */
export interface RecoveryStartWritesInput {
	/** @internal */
	process: ProcessInstance;
	/** @internal */
	failedRun: ProcessTurnRecord;
	/** @internal */
	acceptedStart: TurnStartRecord;
}

export function buildRecoveryStartWrites(
	{ process, failedRun, acceptedStart }: RecoveryStartWritesInput,
	recovery:
		| { startKind: "retry"; turnType: "llm" | "automatic"; continuation: null }
		| {
				startKind: "continue";
				turnType: "llm";
				continuation: NonNullable<TurnStartRecord["continuation"]>;
		  },
): Writes {
	if (
		acceptedStart.state.kind !== "accepted" ||
		(recovery.startKind === "continue" && acceptedStart.state.start.kind !== "llm")
	) {
		throw new Error(
			recovery.startKind === "retry"
				? "Retry requires an accepted start"
				: "Continue requires an accepted LLM start",
		);
	}
	const plan = createWrites({ workerIntent: { kind: "restart_worker" } });
	const startId = generateId("tsr");
	const provenance = failedRun.modelSelectionProvenance ?? {
		kind: "inherited" as const,
		source: "legacy_persisted" as const,
	};
	plan.turnStartWrites.push({
		kind: "create",
		input: {
			...recovery,
			id: startId,
			instanceId: process.id,
			turnId: failedRun.turnId,
			proposedTurnRecordId: generateId("trn"),
			recoveryTurnRecordId: failedRun.id,
			state:
				recovery.turnType === "automatic"
					? { kind: "starting", start: { kind: "automatic" } }
					: {
							kind: "preparation_failed",
							requestedModelProfileId: failedRun.modelProfileId,
							providerOptions:
								acceptedStart.state.start.kind === "llm"
									? { ...acceptedStart.state.start.providerOptions }
									: {},
							code: "model_required",
							safeSummary: `Model selection is pending ${recovery.startKind} preparation`,
							modelSelectionProvenance: provenance,
						},
		},
	});
	applyProcessPatchField(plan, process, "selectedTurnId", failedRun.turnId);
	applyProcessPatchField(plan, process, "lifecycleStatus", "active");
	applyProcessPatchField(plan, process, "currentExecution", { kind: "worker_start", id: startId });
	if (failedRun.modelProfileId !== null) {
		applyProcessPatchField(plan, process, "selectedTurnModelProfileId", failedRun.modelProfileId);
		applyProcessPatchField(plan, process, "selectedTurnModelKind", provenance.kind);
		applyProcessPatchField(plan, process, "selectedTurnModelSource", provenance.source);
	}
	return plan;
}
