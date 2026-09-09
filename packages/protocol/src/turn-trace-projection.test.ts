import { expect, it } from "vitest";
import {
	applyPiEventToLiveTurnProjection,
	createMutableLiveTurnProjection,
} from "./live-turn-projection.js";
import { snapshotTurnTrace } from "./turn-trace-projection.js";

it.each([
	{ text: "  result\n\n", details: { truncation: { truncated: true } }, truncated: true },
	{ text: "result", details: { outputTruncated: true }, truncated: true },
	{ text: "Output truncated after 100 lines", details: {}, truncated: true },
	{ text: "  result\n\n", details: { truncation: { truncated: false } }, truncated: false },
])("presents recorded tool content and truncation consistently: %j", ({
	text,
	details,
	truncated,
}) => {
	const projection = createMutableLiveTurnProjection();
	applyPiEventToLiveTurnProjection(projection, {
		eventType: "pi.tool.result",
		data: {
			toolCallId: "tool",
			toolName: "read",
			result: { content: [{ type: "text", text }], details },
		},
		fallbackTimestamp: "2026-09-09T00:00:00Z",
	});
	expect(snapshotTurnTrace(projection).toolCalls[0]).toMatchObject({ resultText: text, truncated });
	expect(snapshotTurnTrace(projection).toolCalls[0]).not.toHaveProperty("details");
});
