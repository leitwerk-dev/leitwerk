import type { ProcessEvent } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import type { TurnTraceSnapshot } from "./http-contracts.js";
import { createLiveTurnProjection, restoreTurnTraceProjection } from "./live-turn-projection.js";

describe("live-turn-projection", () => {
	it("orders same-timestamp events by persisted creation time", () => {
		const projection = createLiveTurnProjection([
			{
				id: "evt_3",
				instanceId: "agt_1",
				eventType: "pi.stream.delta",
				data: {
					turnRecordId: "trn_1",
					streamType: "thinking",
					text: "second\n",
					timestamp: "2026-01-01T00:00:01Z",
				},
				createdAt: "2026-01-01T00:00:02Z",
			},
			{
				id: "evt_2",
				instanceId: "agt_1",
				eventType: "pi.tool.call",
				data: {
					turnRecordId: "trn_1",
					toolCallId: "tool_1",
					name: "bash",
					arguments: { command: "echo ok" },
					timestamp: "2026-01-01T00:00:01Z",
				},
				createdAt: "2026-01-01T00:00:01.500Z",
			},
			{
				id: "evt_1",
				instanceId: "agt_1",
				eventType: "pi.stream.delta",
				data: {
					turnRecordId: "trn_1",
					streamType: "thinking",
					text: "first\n",
					timestamp: "2026-01-01T00:00:01Z",
				},
				createdAt: "2026-01-01T00:00:01Z",
			},
		]);

		expect(projection.rawSnapshot()).toMatchObject({
			assistant: {
				thinking: "first\nsecond\n",
			},
			traceItems: [
				{ kind: "thinking", text: "first\n" },
				{ kind: "tool_call", toolCallId: "tool_1" },
				{ kind: "thinking", text: "second\n" },
			],
		});
	});

	it.each([
		{
			eventType: "pi.error",
			data: { message: "server_error" },
			severity: "error",
			messageParts: ["server_error"],
		},
		{
			eventType: "pi.retry.start",
			data: { attempt: 1, maxAttempts: 3, delayMs: 2000 },
			severity: "warning",
			messageParts: ["1/3", "2000"],
		},
		{
			eventType: "pi.compaction.end",
			data: { reason: "overflow", willRetry: true },
			severity: "success",
			messageParts: ["overflow", "continue automatically"],
		},
	])("presents $eventType as a $severity trace event", ({
		eventType,
		data,
		severity,
		messageParts,
	}) => {
		const projection = createLiveTurnProjection([
			{
				id: "event",
				instanceId: "process",
				eventType,
				data,
				createdAt: "2026-01-01T00:00:01Z",
			},
		]);
		const trace = projection.rawSnapshot().traceItems;
		expect(trace).toMatchObject([{ kind: "operational_event", eventType, severity }]);
		for (const text of messageParts) {
			expect(trace[0]).toMatchObject({ message: expect.stringContaining(text) });
		}
	});

	it("aggregates cumulative usage and cost across multiple pi.usage events", () => {
		const projection = createLiveTurnProjection([
			{
				id: "evt_usage_1",
				instanceId: "agt_1",
				eventType: "pi.usage",
				data: {
					turnRecordId: "trn_1",
					input: 100,
					output: 20,
					reasoning: 12,
					cacheRead: 300,
					cacheWrite: 40,
					totalTokens: 460,
					cost: {
						input: 1,
						output: 2,
						cacheRead: 0.5,
						cacheWrite: 0.25,
						total: 3.75,
					},
					timestamp: "2026-01-01T00:00:02Z",
				},
				createdAt: "2026-01-01T00:00:02Z",
			},
			{
				id: "evt_usage_2",
				instanceId: "agt_1",
				eventType: "pi.usage",
				data: {
					turnRecordId: "trn_1",
					input: 80,
					output: 30,
					reasoning: 8,
					cacheRead: 5,
					cacheWrite: 0,
					totalTokens: 115,
					cost: {
						input: 0.75,
						output: 0.5,
						cacheRead: 0.125,
						cacheWrite: 0,
						total: 1.375,
					},
					timestamp: "2026-01-01T00:00:03Z",
				},
				createdAt: "2026-01-01T00:00:03Z",
			},
		]);

		expect(projection.rawSnapshot().usage).toEqual({
			input: 180,
			output: 50,
			reasoning: 20,
			cacheRead: 305,
			cacheWrite: 40,
			totalTokens: 575,
			cost: {
				input: 1.75,
				output: 2.5,
				cacheRead: 0.625,
				cacheWrite: 0.25,
				total: 5.125,
			},
			requestCount: 2,
			maxInputTokens: 100,
		});
	});
});

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
	const projection = createLiveTurnProjection();
	projection.apply({
		eventType: "pi.tool.result",
		data: {
			toolCallId: "tool",
			toolName: "read",
			result: { content: [{ type: "text", text }], details },
		},
		fallbackTimestamp: "2026-09-09T00:00:00Z",
	});
	expect(projection.snapshot().toolCalls[0]).toMatchObject({ resultText: text, truncated });
	expect(projection.snapshot().toolCalls[0]).not.toHaveProperty("result");
	expect(projection.snapshot().toolCalls[0]).not.toHaveProperty("details");
});

it("restores running tools and correlates later results in the same order as live execution", () => {
	const timestamp = "2026-10-05T00:00:00Z";
	const projection = createLiveTurnProjection();
	for (const toolCallId of ["first", "second", "third"]) {
		projection.apply({
			eventType: "pi.tool.call",
			data: { toolCallId, toolName: "read", arguments: { path: toolCallId } },
			fallbackTimestamp: timestamp,
		});
	}
	const restored = restoreTurnTraceProjection(projection.snapshot());
	const completions = [
		{ toolCallId: "second", toolName: "read", result: "explicit result" },
		{ toolName: "read", result: "latest running result" },
		{ toolName: "read", result: "earliest running result" },
	];
	for (const [index, data] of completions.entries()) {
		const event = {
			eventType: "pi.tool.result",
			data,
			fallbackTimestamp: timestamp,
		};
		const applied = restored.apply(event);
		expect(applied.toolCallId).toBe(["second", "third", "first"][index]);
		expect(applied.canonicalData.toolCallId).toBe(applied.toolCallId);
		projection.apply(event);
		expect(restored.snapshot()).toEqual(projection.snapshot());
	}
	expect(restored.snapshot().toolCalls.map((tool) => [tool.toolCallId, tool.status])).toEqual([
		["first", "completed"],
		["second", "completed"],
		["third", "completed"],
	]);
});

it.each([
	"replay",
	"restore",
] as const)("avoids fallback identities already retained by %s", (mode) => {
	const timestamp = "2026-10-05T00:00:00Z";
	const existingId = `read:${timestamp}:1`;
	const events: ProcessEvent[] = [
		{
			id: "event",
			instanceId: "process",
			eventSequence: 1,
			eventType: "pi.tool.call",
			data: { toolCallId: existingId, toolName: "read", arguments: { path: "old" } },
			createdAt: timestamp,
		},
	];
	const recorded = createLiveTurnProjection(events);
	const projection =
		mode === "restore" ? restoreTurnTraceProjection(recorded.snapshot()) : recorded;
	const applied = projection.apply({
		eventType: "pi.tool.call",
		data: { name: "read", args: { path: "new" } },
		fallbackTimestamp: timestamp,
	});
	expect(applied.toolCallId).toBe(`read:${timestamp}:2`);
	expect(applied.canonicalData).toEqual({
		name: "read",
		args: { path: "new" },
		toolCallId: applied.toolCallId,
	});
	expect(projection.snapshot().toolCalls).toMatchObject([
		{ toolCallId: existingId, arguments: { path: "old" } },
		{ toolCallId: applied.toolCallId, arguments: { path: "new" } },
	]);
});

it("preserves restored presentation and usage while accepting new activity", () => {
	const timestamp = "2026-10-05T00:00:00Z";
	const trace: TurnTraceSnapshot = {
		assistant: { text: "Answer", thinking: "Thinking", lastUpdatedAt: timestamp },
		toolCalls: [
			{
				toolCallId: "read",
				toolName: "read",
				status: "completed",
				startedAt: timestamp,
				completedAt: timestamp,
				arguments: { path: "file" },
				resultText: "  retained output\n\n",
				truncated: true,
				isError: false,
			},
		],
		traceItems: [
			{ kind: "thinking", text: "Thinking" },
			{ kind: "tool_call", toolCallId: "read" },
		],
		usage: {
			input: 10,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 13,
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
			requestCount: 1,
			maxInputTokens: 10,
		},
		piInput: { parts: [], fullPrompt: "Read file", createdAt: timestamp, userInput: "Read file" },
	};
	const projection = restoreTurnTraceProjection(trace);
	expect(projection.snapshot()).toEqual(trace);
	const before = projection.snapshot();
	trace.assistant.text = "Changed input";
	trace.toolCalls[0].toolCallId = "Changed input";
	if (trace.usage) trace.usage.input = 1_000;
	expect(projection.snapshot()).toEqual(before);

	const applied = projection.apply({
		eventType: "pi.usage",
		data: { input: 20, output: 4, cost: { input: 2, output: 3, total: 5 } },
		fallbackTimestamp: timestamp,
	});
	projection.apply({
		eventType: "pi.stream.delta",
		data: { text: " continued" },
		fallbackTimestamp: timestamp,
	});
	const after = projection.snapshot();
	expect(after).toMatchObject({
		assistant: { text: "Answer continued", thinking: "Thinking" },
		toolCalls: before.toolCalls,
		traceItems: before.traceItems,
		piInput: before.piInput,
		usage: {
			input: 30,
			output: 7,
			cost: { input: 3, output: 5, total: 8 },
			requestCount: 2,
			maxInputTokens: 20,
		},
	});
	expect(applied.usage).toEqual(after.usage);
	if (applied.usage) applied.usage.input = 2_000;
	after.toolCalls[0].status = "running";
	after.assistant.text = "Changed output";
	expect(projection.snapshot()).toMatchObject({
		assistant: { text: "Answer continued" },
		toolCalls: [{ status: "completed", resultText: "  retained output\n\n", truncated: true }],
		usage: { input: 30 },
	});
});

it("retains original recorded results and replaces restored presentation when a new result arrives", () => {
	const projection = createLiveTurnProjection();
	const result = {
		content: [{ type: "text", text: "first result" }],
		details: { truncation: { truncated: true }, extra: "recorded metadata" },
	};
	projection.apply({
		eventType: "pi.tool.result",
		data: { toolCallId: "read", toolName: "read", result },
		fallbackTimestamp: "2026-10-05T00:00:00Z",
	});
	expect(projection.rawSnapshot().toolCalls[0].result).toEqual(result);
	const restored = restoreTurnTraceProjection(projection.snapshot());
	expect(restored).not.toHaveProperty("rawSnapshot");
	restored.apply({
		eventType: "pi.tool.result",
		data: { toolCallId: "read", toolName: "read", result: "complete replacement" },
		fallbackTimestamp: "2026-10-05T00:00:01Z",
	});
	expect(restored.snapshot().toolCalls).toMatchObject([
		{ toolCallId: "read", resultText: "complete replacement", truncated: false },
	]);
});
