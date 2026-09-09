import { expect, it } from "vitest";
import { applyEventToCompactTurnSummary, emptyCompactTurnSummary } from "./compact-turn-summary.js";

it("retains paragraph context through blank-heavy token updates without retaining history or tool payloads", () => {
	let summary = emptyCompactTurnSummary();
	let eventSequence = 0;
	const append = (eventType: string, data: Record<string, unknown>) => {
		summary = applyEventToCompactTurnSummary(summary, {
			eventType,
			data,
			createdAt: "2026-09-09",
			eventSequence: ++eventSequence,
		});
	};
	append("pi.stream.delta", { streamType: "thinking", text: "Previous context.\n\n" });
	append("pi.stream.delta", { streamType: "thinking", text: "\n \n".repeat(2000) });
	append("pi.stream.delta", { streamType: "thinking", text: "New paragraph" });
	expect(summary.assistant.thinking).toBe("Previous context.\nNew paragraph");
	for (let i = 0; i < 2000; i++) {
		append("pi.stream.delta", { streamType: "thinking", text: ` paragraph ${i}` });
		append("pi.tool.call", {
			toolCallId: `tool-${i}`,
			toolName: "read",
			arguments: { huge: "private args".repeat(1000) },
		});
		append("pi.tool.result", {
			toolCallId: `tool-${i}`,
			toolName: "read",
			result: "huge result".repeat(1000),
		});
	}
	expect(summary.assistant.thinking.length).toBeLessThanOrEqual(1024);
	expect(summary.toolCallCount).toBe(2000);
	expect(summary.currentTool?.status).toBe("completed");
	expect(JSON.stringify(summary).length).toBeLessThan(1600);
	expect(summary).not.toHaveProperty("toolCalls");
	expect(summary).not.toHaveProperty("traceItems");
});
