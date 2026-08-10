import { validateEnvelope } from "./ipc-codec.js";
import type { ServerToWorkerMessage, WorkerToServerMessage } from "./ipc-messages.js";

export type IpcDecodeResult<TMessage> =
	| { ok: true; message: TMessage }
	| { ok: false; error: string };

const SERVER_TO_WORKER_TYPES = [
	"worker.start",
	"worker.turn_start_accepted",
	"worker.credential_update_accepted",
	"worker.question_response",
	"worker.integration_tool_result",
	"input.batch",
	"worker.stop",
	"worker.abort_turn",
] as const satisfies readonly ServerToWorkerMessage["type"][];

const WORKER_TO_SERVER_TYPES = [
	"worker.hello",
	"worker.credential_update",
	"worker.ready",
	"worker.heartbeat",
	"worker.state",
	"worker.input_consumed",
	"worker.event",
	"worker.turn_started",
	"worker.question_requested",
	"worker.integration_tool_request",
	"worker.turn_outcome",
	"worker.turn_failed",
	"worker.lifecycle_parked",
	"worker.cleanup_started",
	"worker.cleanup_completed",
	"worker.failed",
] as const satisfies readonly WorkerToServerMessage["type"][];

function hasMessageType<TType extends string>(
	allowed: readonly TType[],
	value: string,
): value is TType {
	return (allowed as readonly string[]).includes(value);
}

/**
 * Validate the generic IPC envelope and narrow it to the correct typed message
 * union member for the given direction.
 *
 * This intentionally stops at the message discriminant boundary: it validates
 * envelope structure + known message type, but does not deeply validate the
 * payload shape. Payload fields are trusted to come from same-version
 * leitwerk components, so malformed payloads from a buggy sender can still
 * pass through as typed data.
 */
function decodeKnownMessage<TMessage extends { type: string }>(
	msg: unknown,
	allowed: readonly TMessage["type"][],
	direction: string,
): IpcDecodeResult<TMessage> {
	const validated = validateEnvelope(msg);
	if (!validated.ok) {
		return { ok: false, error: validated.error };
	}
	if (!hasMessageType(allowed, validated.envelope.type)) {
		return {
			ok: false,
			error: `unexpected ${direction} message type: ${validated.envelope.type}`,
		};
	}
	return { ok: true, message: validated.envelope as unknown as TMessage };
}

/**
 * Decode a parsed envelope coming from the server side of the IPC channel.
 * Only envelope structure + message type are runtime-validated.
 */
export function decodeServerToWorkerMessage(msg: unknown): IpcDecodeResult<ServerToWorkerMessage> {
	return decodeKnownMessage(msg, SERVER_TO_WORKER_TYPES, "server-to-worker");
}

/**
 * Decode a parsed envelope coming from the worker side of the IPC channel.
 * Only envelope structure + message type are runtime-validated.
 */
export function decodeWorkerToServerMessage(msg: unknown): IpcDecodeResult<WorkerToServerMessage> {
	return decodeKnownMessage(msg, WORKER_TO_SERVER_TYPES, "worker-to-server");
}
