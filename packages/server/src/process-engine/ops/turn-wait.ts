import type { Actor } from "@leitwerk-dev/domain";
import { accept, modelOverrideMetadata, noWrites, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import { pendingTurnWait, turnWaitPredicate, writeTurnWait } from "../turn-wait-state.js";
import { buildTurnSelectionWrites } from "../writes/build-turn-selection-writes.js";
import {
	appendProcessEvent,
	applyProcessPatchField,
	createWrites,
	type DecisionMetadata,
	isWriteBuildFailure,
	stampActorOnEvents,
} from "../writes/writes.js";

/** Initialize waiting after a compatible process-definition migration. */
export const ArmTurnWait = defineOperation<"arm_turn_wait", { instanceId: string }, void>({
	kind: "arm_turn_wait",
	label: "Wait for turn readiness",
	admission: "new_turn",
	decide({ process, deps }) {
		if (
			pendingTurnWait(process) ||
			process.currentExecution ||
			!process.selectedTurnId ||
			process.lifecycleStatus !== "active" ||
			!turnWaitPredicate(deps.processGraphs, process)
		)
			return noWrites();
		const writes = buildTurnSelectionWrites(deps.processGraphs, process, {
			toTurnId: process.selectedTurnId,
		});
		return isWriteBuildFailure(writes) ? writes : accept({ writes });
	},
});

interface ResolveTurnWaitInput {
	instanceId: string;
	waitId: string;
	revision: number;
	paramsJson: string | null;
	stateJson: string | null;
	projectsJson: string;
	/** State validated and encoded by the readiness service. */
	nextStateJson?: string;
	result: "ready" | "waiting" | "complete" | "retry" | "error";
	message?: string;
	now: number;
	pollIntervalMs: number;
}

/** Commit a check made outside the process lock, only if its inputs are still current. */
export const ResolveTurnWait = defineOperation<"resolve_turn_wait", ResolveTurnWaitInput, void>({
	kind: "resolve_turn_wait",
	label: "Resolve turn readiness",
	admission: "new_turn",
	decide({ process, deps }, input) {
		const wait = pendingTurnWait(process);
		if (
			!wait ||
			wait.id !== input.waitId ||
			wait.revision !== input.revision ||
			process.selectedTurnId !== wait.turnId ||
			process.lifecycleStatus !== "waiting" ||
			process.paramsJson !== input.paramsJson ||
			process.stateJson !== input.stateJson ||
			JSON.stringify(deps.projects.listByInstance(process.id)) !== input.projectsJson
		) {
			return reject("turn_wait_superseded", "The waiting condition has changed");
		}
		const writes = createWrites();
		if (input.nextStateJson !== undefined && !["retry", "error"].includes(input.result))
			applyProcessPatchField(writes, process, "stateJson", input.nextStateJson);
		if (input.result === "ready") {
			writeTurnWait(writes, process, null);
			writes.waitForAdmission = wait.id;
			writes.turnStartWrites.push({ kind: "create", input: wait.start });
			applyProcessPatchField(writes, process, "currentExecution", {
				kind: "worker_start",
				id: wait.start.id as string,
			});
			applyProcessPatchField(writes, process, "lifecycleStatus", "active");
			writes.workerIntent = { kind: "reconcile" };
			return accept({ writes, metadata: wait.metadata });
		}
		if (input.result === "complete") {
			writeTurnWait(writes, process, null);
			applyProcessPatchField(writes, process, "selectedTurnId", null);
			applyProcessPatchField(writes, process, "currentExecution", null);
			applyProcessPatchField(writes, process, "lifecycleStatus", "completed");
			writes.workerIntent = { kind: "reconcile" };
			appendProcessEvent(writes, process, {
				eventType: "process_completed",
				level: "info",
				message: "Waiting condition completed the process",
			});
			return accept({ writes });
		}
		const failures = input.result === "retry" ? wait.failures + 1 : 0;
		const message = input.message ?? null;
		writeTurnWait(writes, process, {
			...wait,
			revision: wait.revision + 1,
			status: input.result === "error" ? "error" : "waiting",
			failures,
			message,
			nextCheckAt:
				input.now +
				(failures
					? Math.min(300_000, input.pollIntervalMs * 2 ** Math.min(failures, 8))
					: input.pollIntervalMs),
		});
		if (input.result === "error")
			applyProcessPatchField(writes, process, "lifecycleStatus", "error");
		if (message !== wait.message)
			appendProcessEvent(writes, process, {
				eventType: message ? "turn_wait_failed" : "turn_wait_recovered",
				level: message ? "warn" : "info",
				message: message ?? "Waiting condition recovered",
				data: { turnId: wait.turnId, retryable: input.result === "retry", safeSummary: message },
			});
		writes.preserveUpdatedAt =
			input.result !== "error" &&
			message === wait.message &&
			writes.changedFields.every((field) => field === "metadata");
		return accept({ writes });
	},
});

export const RetryTurnWait = defineOperation<
	"retry_turn_wait",
	DecisionMetadata & { instanceId: string; actor?: Actor },
	void
>({
	kind: "retry_turn_wait",
	label: "Retry waiting condition",
	admission: "new_turn",
	decide({ process }, input) {
		const wait = pendingTurnWait(process);
		if (!wait || wait.status !== "error" || process.lifecycleStatus !== "error")
			return reject("retry_target_missing", "No failed waiting condition is current");
		const writes = createWrites();
		writeTurnWait(writes, process, {
			...wait,
			status: "waiting",
			revision: wait.revision + 1,
			nextCheckAt: 0,
			failures: 0,
			message: null,
			metadata: { ...wait.metadata, ...modelOverrideMetadata(input) },
		});
		applyProcessPatchField(writes, process, "lifecycleStatus", "waiting");
		appendProcessEvent(writes, process, {
			eventType: "turn_wait_retry",
			level: "info",
			message: "Waiting condition retry requested",
			data: { turnId: wait.turnId },
		});
		stampActorOnEvents(writes, input.actor, "turn_wait_retry");
		return accept({ writes });
	},
});
