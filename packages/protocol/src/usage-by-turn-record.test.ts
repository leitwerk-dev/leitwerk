import type { ProcessEvent } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { buildUsageSnapshotsByTurnRecordId } from "./usage-by-turn-record.js";

function event(input: ProcessEvent): ProcessEvent {
	return input;
}

describe("buildUsageSnapshotsByTurnRecordId", () => {
	it("aggregates usage events by durable turn record id", () => {
		expect(
			buildUsageSnapshotsByTurnRecordId([
				event({
					id: "evt_1",
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
					},
					createdAt: "2026-01-01T00:00:01.000Z",
				}),
				event({
					id: "evt_2",
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
					},
					createdAt: "2026-01-01T00:00:02.000Z",
				}),
				event({
					id: "evt_3",
					instanceId: "agt_1",
					eventType: "pi.usage",
					data: {
						turnRecordId: "trn_2",
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
					},
					createdAt: "2026-01-01T00:00:03.000Z",
				}),
			]),
		).toEqual({
			trn_1: {
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
			},
			trn_2: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: null,
				requestCount: 1,
				maxInputTokens: 10,
			},
		});
	});

	it("keeps explicit zero-usage telemetry as a covered zero-cost turn", () => {
		expect(
			buildUsageSnapshotsByTurnRecordId([
				event({
					id: "evt_zero",
					instanceId: "agt_1",
					eventType: "pi.usage",
					data: {
						turnRecordId: "trn_zero",
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					createdAt: "2026-01-01T00:00:01.000Z",
				}),
			]),
		).toEqual({
			trn_zero: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
				requestCount: 1,
				maxInputTokens: 0,
			},
		});
	});

	it("ignores usage events that are not correlated to a durable turn record id", () => {
		expect(
			buildUsageSnapshotsByTurnRecordId([
				event({
					id: "evt_1",
					instanceId: "agt_1",
					eventType: "pi.usage",
					data: {
						input: 100,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 120,
					},
					createdAt: "2026-01-01T00:00:01.000Z",
				}),
				event({
					id: "evt_2",
					instanceId: "agt_1",
					eventType: "pi.stream.delta",
					data: {
						turnRecordId: "trn_1",
						text: "hello",
					},
					createdAt: "2026-01-01T00:00:02.000Z",
				}),
			]),
		).toEqual({});
	});
});
