import { describe, expect, it } from "vitest";
import { parseScheduleRequestInput } from "./http-contracts.js";
import {
	parsePrimaryPathWsFrameInput,
	parseWsFrame,
	WS_PRIMARY_PATH_TYPES,
	WS_PROTOCOL_VERSION,
} from "./protocol.js";

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
