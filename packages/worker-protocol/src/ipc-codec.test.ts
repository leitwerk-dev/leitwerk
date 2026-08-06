import {
	parsePrimaryPathWsFrameInput,
	parseWsFrame,
	WS_PRIMARY_PATH_TYPES,
	WS_PROTOCOL_VERSION,
} from "@leitwerk-dev/protocol";
import { parseScheduleRequestInput } from "@leitwerk-dev/protocol/http-contracts";
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
			expect(() => JSON.parse(json)).not.toThrow();
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

	describe("contract helpers", () => {
		it("keeps http payloads normalized and ws parsing shallow", () => {
			expect(
				parseScheduleRequestInput({ mode: "cron", cronExpression: " 0 * * * * " }),
			).toMatchObject({ ok: true, value: { cronExpression: "0 * * * *" } });
			expect(
				parseWsFrame({
					protocol: WS_PROTOCOL_VERSION,
					type: "process.created",
					durability: "ephemeral",
					sentAt: "2026-01-01T00:00:00.000Z",
					payload: {},
				}).ok,
			).toBe(false);
		});

		it("parses valid primary-path frames with schema-backed payload validation", () => {
			expect(
				parsePrimaryPathWsFrameInput({
					protocol: WS_PROTOCOL_VERSION,
					type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED,
					durability: "ephemeral",
					sentAt: "2026-01-01T00:00:00.000Z",
					payload: {
						turnRecordId: "trn_1",
						piTurnId: "pi_1",
						timestamp: "2026-01-01T00:00:00.000Z",
						toolCallId: "call_1",
						toolName: "bash",
						arguments: { command: "pwd" },
					},
				}),
			).toMatchObject({
				ok: true,
				value: {
					type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED,
					payload: {
						toolCallId: "call_1",
						toolName: "bash",
					},
				},
			});
		});

		it("rejects malformed primary-path payloads that pass the shallow envelope parser", () => {
			expect(
				parsePrimaryPathWsFrameInput({
					protocol: WS_PROTOCOL_VERSION,
					type: WS_PRIMARY_PATH_TYPES.TURN_STARTED,
					durability: "durable",
					sentAt: "2026-01-01T00:00:00.000Z",
					instanceId: "agt_1",
					payload: { turnRecord: { id: "trn_1" } },
				}),
			).toEqual({
				ok: false,
				error: expect.stringContaining("primary_path ws frame.payload"),
			});
		});
	});
});
