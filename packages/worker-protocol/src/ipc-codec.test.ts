import { describe, expect, it } from "vitest";
import {
	deserializeMessage,
	IPC_PROTOCOL_VERSION,
	type IpcEnvelope,
	serializeMessage,
	validateEnvelope,
} from "./ipc-codec.js";

function sampleEnvelope(overrides: Partial<IpcEnvelope> = {}): IpcEnvelope {
	return {
		protocol: IPC_PROTOCOL_VERSION,
		messageId: "m1",
		type: "worker.hello",
		instanceId: "a1",
		workerId: "w1",
		sentAt: "2026-01-01T00:00:00.000Z",
		payload: { x: 1 },
		...overrides,
	};
}

describe("ipc-codec", () => {
	describe("serializeMessage", () => {
		it("produces valid JSON", () => {
			const env = sampleEnvelope();
			const json = serializeMessage(env);
			expect(json).not.toContain("\n");
			expect(JSON.parse(json)).toEqual(env);
		});
	});

	describe("deserializeMessage", () => {
		it("parses valid JSON frames", () => {
			const env = sampleEnvelope();
			const line = JSON.stringify(env);
			const r = deserializeMessage(line);
			expect(r).toEqual({ ok: true, message: env });
		});

		it("rejects malformed JSON", () => {
			const r = deserializeMessage("{not json");
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.error).toBe("invalid JSON");
			}
		});

		it("rejects missing required fields", () => {
			const r = deserializeMessage(JSON.stringify({ protocol: IPC_PROTOCOL_VERSION }));
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.error).toContain("ipc envelope.messageId");
			}
		});
	});

	describe("validateEnvelope", () => {
		it("accepts valid envelopes", () => {
			const env = sampleEnvelope({ correlationId: "c1" });
			const r = validateEnvelope(env);
			expect(r).toEqual({ ok: true, envelope: env });
		});

		it("rejects incomplete envelopes", () => {
			const r = validateEnvelope({
				protocol: IPC_PROTOCOL_VERSION,
				messageId: "m1",
			});
			expect(r.ok).toBe(false);
		});

		it("reports old worker IPC protocols as incompatible", () => {
			expect(
				validateEnvelope({ ...sampleEnvelope(), protocol: "orchestrator-v2/worker-ipc/v1" }),
			).toEqual({
				ok: false,
				error:
					"Worker IPC protocol 'orchestrator-v2/worker-ipc/v1' is incompatible with expected protocol 'leitwerk/worker-ipc/v1'",
			});
		});
	});
});
