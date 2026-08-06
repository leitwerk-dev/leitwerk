import type { ProcessEvent } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	buildLiveTurnProjectionFromEvents,
	snapshotLiveTurnProjection,
} from "./live-turn-projection.js";

function event(input: ProcessEvent): ProcessEvent {
	return input;
}

describe("live-turn-projection", () => {
	it("orders same-timestamp events by persisted creation time", () => {
		const projection = buildLiveTurnProjectionFromEvents([
			event({
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
			}),
			event({
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
			}),
			event({
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
			}),
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

	it("adds retry, error, and compaction events to the live trace", () => {
		const projection = buildLiveTurnProjectionFromEvents([
			event({
				id: "evt_error",
				instanceId: "agt_1",
				eventType: "pi.error",
				data: {
					turnRecordId: "trn_1",
					message: "server_error",
					timestamp: "2026-01-01T00:00:01Z",
				},
				createdAt: "2026-01-01T00:00:01Z",
			}),
			event({
				id: "evt_retry",
				instanceId: "agt_1",
				eventType: "pi.retry.start",
				data: {
					turnRecordId: "trn_1",
					attempt: 1,
					maxAttempts: 3,
					delayMs: 2000,
					timestamp: "2026-01-01T00:00:02Z",
				},
				createdAt: "2026-01-01T00:00:02Z",
			}),
			event({
				id: "evt_compaction",
				instanceId: "agt_1",
				eventType: "pi.compaction.end",
				data: {
					turnRecordId: "trn_1",
					reason: "overflow",
					willRetry: true,
					timestamp: "2026-01-01T00:00:03Z",
				},
				createdAt: "2026-01-01T00:00:03Z",
			}),
		]);

		expect(snapshotLiveTurnProjection(projection).traceItems).toEqual([
			expect.objectContaining({
				kind: "operational_event",
				eventType: "pi.error",
				severity: "error",
				message: "server_error",
			}),
			expect.objectContaining({
				kind: "operational_event",
				eventType: "pi.retry.start",
				severity: "warning",
				message: "Retry 1/3 scheduled in 2000ms.",
			}),
			expect.objectContaining({
				kind: "operational_event",
				eventType: "pi.compaction.end",
				severity: "success",
				message: "Pi compacted context (overflow). Pi will continue automatically.",
			}),
		]);
	});

	it("aggregates cumulative usage and cost across multiple pi.usage events", () => {
		const projection = buildLiveTurnProjectionFromEvents([
			event({
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
			}),
			event({
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
			}),
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
