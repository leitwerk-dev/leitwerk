import {
	createEphemeralWsFrame,
	type TurnReasoningDetailResponseBody,
	type WsFrame,
} from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import { ReasoningHistory } from "./reasoning-history.js";

const response = (
	thinking: string,
	throughEventSequence: number,
): TurnReasoningDetailResponseBody => ({
	instanceId: "process",
	turnRecordId: "turn",
	sessionSignature: null,
	state: "live",
	throughEventSequence,
	reasoning: {
		assistant: { text: "", thinking, lastUpdatedAt: null },
		toolCalls: [],
		traceItems: [{ kind: "thinking", text: thinking }],
		usage: null,
		piInput: null,
	},
});
function delta(sequence: number, text: string, turnRecordId = "turn"): WsFrame {
	return createEphemeralWsFrame({
		type: "pi.stream.delta",
		instanceId: "process",
		eventSequence: sequence,
		sentAt: "2026-09-09T00:00:00Z",
		payload: { turnRecordId, streamType: "thinking", text },
	});
}

describe("expanded reasoning recovery", () => {
	it("replays more than 1,000 buffered frames once in persisted order regardless of timestamps", () => {
		const history = new ReasoningHistory("process", "turn");
		history.accept(response("prefix", 1));
		history.beginRequest();
		for (let sequence = 2_000; sequence > 1; sequence--) {
			history.push(delta(sequence, ` ${sequence}`));
			history.push(delta(sequence, ` ${sequence}`));
		}
		const trace = history.accept(response("prefix 2 3", 3));
		expect(trace.assistant.thinking).toBe(
			`prefix${Array.from({ length: 1999 }, (_, i) => ` ${i + 2}`).join("")}`,
		);
		expect(history.push(delta(2000, "duplicate"))).toBeNull();
		expect(history.push(delta(2001, "wrong", "another"))).toBeNull();
	});
	it("keeps visible content on failure, accumulates tool results and usage across calls, and freezes a committed trace", () => {
		const history = new ReasoningHistory("process", "turn");
		history.accept(response("reasoning", 1));
		history.beginRequest();
		history.push(delta(2, " retained"));
		history.failedRequest();
		expect(history.snapshot().assistant.thinking).toBe("reasoning retained");
		const send = (
			type: "pi.tool.started" | "pi.tool.completed" | "pi.usage" | "pi.retry.start",
			sequence: number,
			payload: Record<string, unknown>,
		) =>
			history.push(
				createEphemeralWsFrame({
					type,
					instanceId: "process",
					eventSequence: sequence,
					payload: { ...payload, turnRecordId: "turn" },
				}),
			);
		send("pi.tool.started", 3, {
			toolCallId: "read",
			toolName: "read",
			arguments: { path: "file" },
		});
		send("pi.tool.completed", 4, {
			toolCallId: "read",
			toolName: "read",
			result: {
				content: [{ type: "text", text: "full result" }],
				details: { privatePath: "hidden" },
			},
		});
		send("pi.usage", 5, { input: 5, output: 3 });
		send("pi.retry.start", 6, { message: "Retry" });
		send("pi.usage", 7, { input: 8, output: 2 });
		expect(history.snapshot().toolCalls[0].resultText).toBe("full result");
		expect(history.snapshot().usage?.input).toBe(13);
		expect(history.snapshot().traceItems.at(-1)?.kind).toBe("operational_event");
		history.beginRequest();
		history.push(delta(8, " late"));
		history.accept({ ...response("committed reasoning", 9), state: "committed" });
		expect(history.push(delta(10, "stale live frame"))).toBeNull();
		expect(history.snapshot().assistant.thinking).toBe("committed reasoning");
	});
});
