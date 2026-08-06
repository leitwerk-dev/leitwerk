import { parseSchema } from "@leitwerk-dev/protocol";
import * as v from "valibot";

export const IPC_PROTOCOL_VERSION = "leitwerk/worker-ipc/v1" as const;

export const IPC_ENVELOPE_SCHEMA = v.object({
	protocol: v.literal(IPC_PROTOCOL_VERSION),
	messageId: v.string(),
	correlationId: v.optional(v.string()),
	type: v.string(),
	instanceId: v.string(),
	workerId: v.string(),
	sentAt: v.string(),
	payload: v.unknown(),
});

export type IpcEnvelope = v.InferOutput<typeof IPC_ENVELOPE_SCHEMA>;

export function validateEnvelope(
	msg: unknown,
): { ok: true; envelope: IpcEnvelope } | { ok: false; error: string } {
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

export function serializeMessage<TEnvelope extends IpcEnvelope>(envelope: TEnvelope): string {
	return JSON.stringify(envelope);
}

export function deserializeMessage(
	line: string,
): { ok: true; message: IpcEnvelope } | { ok: false; error: string } {
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
