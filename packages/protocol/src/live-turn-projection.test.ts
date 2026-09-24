import { describe, expect, it } from "vitest";
import {
	buildLiveTurnProjectionFromEvents,
	snapshotLiveTurnProjection,
} from "./live-turn-projection.js";

describe("live-turn-projection", () => {
	it("orders same-timestamp events by persisted creation time", () => {
		const projection = buildLiveTurnProjectionFromEvents([
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

		expect(snapshotLiveTurnProjection(projection)).toMatchObject({
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
		const projection = buildLiveTurnProjectionFromEvents([
			{
				id: "event",
				instanceId: "process",
				eventType,
				data,
				createdAt: "2026-01-01T00:00:01Z",
			},
		]);
		const trace = snapshotLiveTurnProjection(projection).traceItems;
		expect(trace).toMatchObject([{ kind: "operational_event", eventType, severity }]);
		for (const text of messageParts) {
			expect(trace[0]).toMatchObject({ message: expect.stringContaining(text) });
		}
	});

	it("aggregates cumulative usage and cost across multiple pi.usage events", () => {
		const projection = buildLiveTurnProjectionFromEvents([
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

		expect(snapshotLiveTurnProjection(projection).usage).toEqual({
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
