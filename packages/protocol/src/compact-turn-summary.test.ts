import { expect, it } from "vitest";
import { applyEventToCompactTurnSummary, emptyCompactTurnSummary } from "./compact-turn-summary.js";

function summarize(events: [string, Record<string, unknown>][]) {
	return events.reduce(
		(summary, [eventType, data], index) =>
			applyEventToCompactTurnSummary(summary, {
				eventType,
				data,
				createdAt: "2026-09-09",
				eventSequence: index + 1,
			}),
		emptyCompactTurnSummary(),
	);
}

it("retains preceding paragraph context across blank-only thinking updates", () => {
	const summary = summarize([
		["pi.stream.delta", { streamType: "thinking", text: "Previous context.\n\n" }],
		["pi.stream.delta", { streamType: "thinking", text: "\n \n".repeat(2000) }],
		["pi.stream.delta", { streamType: "thinking", text: "New paragraph" }],
	]);
	expect(summary.assistant.thinking).toBe("Previous context.\nNew paragraph");
});

it("retains a bounded preview and the latest tool status instead of accumulating history", () => {
	const events: [string, Record<string, unknown>][] = [];
	for (let i = 0; i < 2000; i++) {
		events.push(
			["pi.stream.delta", { streamType: "thinking", text: ` paragraph ${i}` }],
			[
				"pi.tool.call",
				{ toolCallId: `tool-${i}`, toolName: "read", arguments: { path: "private-path" } },
			],
			["pi.tool.result", { toolCallId: `tool-${i}`, toolName: "read", result: "private-result" }],
		);
	}
	const summary = summarize(events);
	expect(summary.assistant.thinking.length).toBeLessThanOrEqual(1024);
	expect(summary.assistant.thinking).toMatch(/paragraph 1999$/);
	expect(summary.toolCallCount).toBe(2000);
	expect(summary.currentTool).toEqual({
		toolCallId: "tool-1999",
		toolName: "read",
		status: "completed",
		isError: false,
	});
	expect(summary).not.toHaveProperty("toolCalls");
	expect(summary).not.toHaveProperty("traceItems");
	const serialized = JSON.stringify(summary);
	expect(serialized.length).toBeLessThan(1600);
	expect(serialized).not.toContain("private-path");
	expect(serialized).not.toContain("private-result");
});
