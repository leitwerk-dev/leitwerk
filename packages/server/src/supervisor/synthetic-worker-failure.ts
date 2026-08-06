import { randomUUID } from "node:crypto";
import { createIpcMessage, type WorkerToServerMessage } from "@leitwerk-dev/worker-protocol";

// Normalizes server-side worker failure observations (startup timeout, stale heartbeat,
// invalid WebSocket IPC, unexpected exit) into the same `worker.failed` IPC shape the
// handler already understands.
export function createServerObservedWorkerFailedMessage(input: {
	instanceId: string;
	workerId: string;
	state?: string;
	errorCode: string;
	message: string;
	errorClass?: string;
	selectedTurnId?: string | null;
}): Extract<WorkerToServerMessage, { type: "worker.failed" }> {
	return createIpcMessage({
		type: "worker.failed",
		instanceId: input.instanceId,
		workerId: input.workerId,
		messageId: randomUUID(),
		payload: {
			state: input.state ?? "absent",
			errorCode: input.errorCode,
			message: input.message,
			errorClass: input.errorClass ?? "infrastructure",
			selectedTurnId: input.selectedTurnId ?? null,
		},
	});
}
