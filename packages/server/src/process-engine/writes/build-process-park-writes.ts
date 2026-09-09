import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { ParkProcessLifecyclePayload } from "../../process-engine/types.js";
import {
	appendProcessEvent,
	applyProcessPatchField,
	createWrites,
	type WriteBuildResult,
} from "./writes.js";

interface ParkProcessWritesOptions {
	allowInactiveLifecycle?: boolean;
}

export function buildParkProcessWrites(
	process: ProcessInstance,
	payload: ParkProcessLifecyclePayload,
	opts: ParkProcessWritesOptions = {},
): WriteBuildResult {
	if (
		payload.selectedTurnId !== undefined &&
		payload.selectedTurnId !== null &&
		payload.selectedTurnId !== process.selectedTurnId
	) {
		return {
			ok: false,
			code: "stale_turn",
			message: `Process selectedTurnId is '${process.selectedTurnId}', not '${payload.selectedTurnId}'`,
		};
	}

	if (!opts.allowInactiveLifecycle && process.lifecycleStatus !== "active") {
		return {
			ok: false,
			code: "invalid_transition",
			message: `No lifecycle park transition from lifecycleStatus '${process.lifecycleStatus}'`,
		};
	}

	const writes = createWrites({
		workerIntent: {
			kind: "stop_with_reason",
			reason: `lifecycle_parked:${process.selectedTurnId ?? process.lifecycleStatus}`,
		},
	});
	applyProcessPatchField(writes, process, "lifecycleStatus", "error");
	appendProcessEvent(writes, process, {
		eventType: "lifecycle_parked",
		level: "warn",
		message: payload.reason
			? `Lifecycle parked with error: ${payload.reason}`
			: "Lifecycle parked with error",
		data: {
			selectedTurnId: process.selectedTurnId,
			reason: payload.reason,
			errorClass: payload.errorClass,
		},
	});

	return writes;
}
