import { parseSchema } from "@leitwerk-dev/protocol";
import * as v from "valibot";

/** @internal */
export const IPC_PROTOCOL_VERSION = "leitwerk/worker-ipc/v1" as const;

/** @internal */
export const IPC_ENVELOPE_SCHEMA = v.object({
	/** @internal */
	protocol: v.literal(IPC_PROTOCOL_VERSION),
	/** @internal */
	messageId: v.string(),
	/** @internal */
	correlationId: v.optional(v.string()),
	/** @internal */
	type: v.string(),
	/** @internal */
	instanceId: v.string(),
	/** @internal */
	workerId: v.string(),
	/** @internal */
	sentAt: v.string(),
	/** @internal */
	payload: v.unknown(),
});

/** @internal */
export type IpcEnvelope = v.InferOutput<typeof IPC_ENVELOPE_SCHEMA>;

/** @internal */
export function validateEnvelope(msg: unknown):
	| {
			/** @internal */
			ok: true;
			/** @internal */
			envelope: IpcEnvelope;
	  }
	| {
			/** @internal */
			ok: false;
			/** @internal */
			error: string;
	  } {
	if (
		typeof msg === "object" &&
		msg !== null &&
		"protocol" in msg &&
		typeof msg.protocol === "string" &&
		msg.protocol !== IPC_PROTOCOL_VERSION
	) {
		return {
			ok: false,
			error: `Worker IPC protocol '${msg.protocol}' is incompatible with expected protocol '${IPC_PROTOCOL_VERSION}'`,
		};
	}
	const envelope = parseSchema(IPC_ENVELOPE_SCHEMA, msg, "ipc envelope");
	return envelope.ok
		? { ok: true, envelope: envelope.value }
		: { ok: false, error: envelope.error };
}

/** @internal */
export function serializeMessage<TEnvelope extends IpcEnvelope>(envelope: TEnvelope): string {
	return JSON.stringify(envelope);
}

/** @internal */
export function deserializeMessage(line: string):
	| {
			/** @internal */
			ok: true;
			/** @internal */
			message: IpcEnvelope;
	  }
	| {
			/** @internal */
			ok: false;
			/** @internal */
			error: string;
	  } {
	const trimmed =
		line.length > 0 && line.charCodeAt(line.length - 1) === 0x0d ? line.slice(0, -1) : line;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed) as unknown;
	} catch {
		return { ok: false, error: "invalid JSON" };
	}
	const validated = validateEnvelope(parsed);
	if (!validated.ok) {
		return { ok: false, error: validated.error };
	}
	return { ok: true, message: validated.envelope };
}
