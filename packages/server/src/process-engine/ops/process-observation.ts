import type { ProcessObservationUpdate } from "@leitwerk-dev/process-sdk";
import { planCancelScheduledAction } from "../../future-execution/transition-planner.js";
import { resolveCurrentExecutionTurnRecordId } from "../../process-execution.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import { writeTurnWait } from "../turn-wait-state.js";
import { reserveSelectedTurnStart } from "../writes/reserve-selected-turn-start.js";
import {
	appendProcessEvent,
	applyMetadataPatch,
	applyProcessPatchField,
	createWrites,
} from "../writes/writes.js";

/** Background reads happen outside the process lock; their writes never bypass coordination. @internal */
export const ApplyProcessObservation = defineOperation<
	"process_observation",
	ProcessObservationUpdate & { instanceId: string },
	void
>({
	kind: "process_observation",
	label: "Record integration observation",
	decide({ process, deps }, input) {
		const expected = input.expected;
		if (
			expected.id !== process.id ||
			expected.processId !== process.processId ||
			expected.planRevision !== process.planRevision ||
			expected.paramsJson !== process.paramsJson ||
			expected.stateJson !== process.stateJson ||
			expected.selectedTurnId !== process.selectedTurnId ||
			expected.lifecycleStatus !== process.lifecycleStatus ||
			JSON.stringify(expected.currentExecution) !== JSON.stringify(process.currentExecution) ||
			Object.keys(input.metadata ?? {}).some(
				(key) =>
					JSON.stringify(expected.metadata?.[key]) !== JSON.stringify(process.metadata?.[key]),
			) ||
			(input.projectsJson !== undefined &&
				input.projectsJson !== JSON.stringify(deps.projects.listByInstance(process.id)))
		)
			return reject("observation_superseded", "The process changed during the integration read");
		const definition = deps.processGraphs.get(process.processId);
		if (!definition) return reject("process_not_found", "Process definition is unavailable");
		const writes = createWrites({ preserveUpdatedAt: input.preserveUpdatedAt });
		if (input.state !== undefined) {
			const state = definition.stateCodec.parse(input.state);
			applyProcessPatchField(
				writes,
				process,
				"stateJson",
				JSON.stringify(definition.stateCodec.serialize(state)),
			);
		}
		if (input.metadata)
			applyMetadataPatch(writes, process, { ...process.metadata, ...input.metadata });
		if (input.lifecycleStatus || input.interrupt) {
			if (["completed", "aborted"].includes(process.lifecycleStatus))
				return reject("invalid_transition", "Terminal processes cannot resume maintenance");
			if (input.interrupt && !definition.turns.has(input.interrupt.turnId))
				return reject("invalid_transition", "Maintenance recovery turn is unavailable");
			const recordId = resolveCurrentExecutionTurnRecordId(process, deps.turnStarts);
			const record = recordId ? deps.turnRecords.getById(recordId) : null;
			if (record?.status === "running")
				writes.turnRecordWrites.push({
					kind: "update",
					id: record.id,
					input: { status: "superseded", endedAt: new Date().toISOString() },
				});
			const start =
				process.currentExecution?.kind === "worker_start"
					? deps.turnStarts.getById(process.currentExecution.id)
					: null;
			if (start?.state.kind === "starting")
				writes.turnStartWrites.push({
					kind: "cas_state",
					id: start.id,
					expectedKind: "starting",
					state: { kind: "superseded", start: start.state.start },
				});
			writes.mappedRunWrites.push({ kind: "abort_active" });
			for (const execution of deps.futureExecutions.listByInstance(process.id)) {
				const plan = planCancelScheduledAction(execution, process.id);
				if (plan) writes.futureExecutionPlans.push(plan);
			}
			writeTurnWait(
				writes,
				{ ...process, metadata: writes.processPatch.metadata ?? process.metadata },
				null,
			);
			applyProcessPatchField(writes, process, "currentExecution", null);
			applyProcessPatchField(
				writes,
				process,
				"selectedTurnId",
				input.lifecycleStatus ? null : (input.interrupt?.turnId ?? process.selectedTurnId),
			);
			applyProcessPatchField(
				writes,
				process,
				"lifecycleStatus",
				input.lifecycleStatus ?? "waiting",
			);
			if (input.interrupt && !input.lifecycleStatus) {
				const turn = definition.turns.get(input.interrupt.turnId)?.definition;
				if (!turn || (turn.kind !== "llm" && turn.kind !== "automatic") || !turn.waitFor)
					return reject(
						"invalid_transition",
						"Maintenance recovery requires an existing gated worker turn",
					);
				reserveSelectedTurnStart(
					writes,
					{ ...process, ...writes.processPatch },
					input.interrupt.turnId,
					turn.kind,
				);
			}
			writes.workerIntent = {
				kind: "stop_with_reason",
				reason: input.interrupt?.reason ?? "MR maintenance finished",
			};
			appendProcessEvent(writes, process, {
				eventType: input.lifecycleStatus
					? `process_${input.lifecycleStatus}`
					: "maintenance_interrupted",
				level: "info",
				message: input.interrupt?.reason ?? "MR maintenance finished",
			});
		}
		return accept({ writes });
	},
});
