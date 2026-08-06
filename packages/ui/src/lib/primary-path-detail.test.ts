import type { ProcessTurnAnnotation } from "@leitwerk-dev/domain";
import {
	type PrimaryPathSnapshot,
	type PrimaryPathWsFrame,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import { applyPrimaryPathFrame, getPrimaryPathActiveTurnOutput } from "./primary-path-detail.js";

function createSnapshot(): PrimaryPathSnapshot {
	return {
		instanceId: "agt_1",
		rebuiltAt: "2026-01-01T00:00:00Z",
		primaryPathEntries: [
			{
				id: "root-user",
				parentId: null,
				type: "message",
				timestamp: "2026-01-01T00:00:00Z",
			},
		],
		currentLeaf: { entryId: "root-user", turnRecordId: null },
		semanticEntryRefs: {
			rootEntry: { entryId: "root-user", turnRecordId: null },
			currentPrimaryPathLeaf: { entryId: "root-user", turnRecordId: null },
			plan: null,
			review: null,
		},
		labels: {},
		turnAnnotations: [],
		detailRail: {
			keyPoints: [],
			futureTurns: [],
			currentPosition: null,
		},
		turnState: {
			currentTurnRecordId: null,
			workerState: "busy",
			isStreaming: false,
			activeTurn: null,
		},
	};
}

function createFrame(
	frame: Omit<PrimaryPathWsFrame, "protocol" | "durability" | "sentAt">,
): PrimaryPathWsFrame {
	return {
		protocol: "leitwerk/ws/v1",
		durability:
			frame.type === WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL ||
			frame.type === WS_PRIMARY_PATH_TYPES.USAGE_UPDATED ||
			frame.type === WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED ||
			frame.type === WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED
				? "ephemeral"
				: "durable",
		sentAt: "2026-01-01T00:00:00Z",
		...frame,
	};
}

describe("applyPrimaryPathFrame", () => {
	it("applies turn start, assistant partials, tool calls, and assistant commit", () => {
		let snapshot = createSnapshot();
		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.TURN_STARTED,
				instanceId: "agt_1",
				payload: {
					turnRecord: {
						id: "trn_live_1",
						instanceId: "agt_1",
						turnId: "generate_plan",
						turnType: "llm",
						status: "running",
						attemptNumber: 1,
						parentTurnRecordId: null,
						pathType: "primary",
						forkPiEntryId: null,
						resultPiEntryId: null,
						turnResultMarkdown: null,
						errorSummary: null,
						startedAt: "2026-01-01T00:00:01Z",
						endedAt: null,
					},
				},
			}),
		);
		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
				instanceId: "agt_1",
				payload: {
					turnRecordId: "trn_live_1",
					piTurnId: "turn-1",
					text: "Need to inspect the repo.\n",
					streamType: "thinking",
					timestamp: "2026-01-01T00:00:01.500Z",
				},
			}),
		);
		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
				instanceId: "agt_1",
				payload: {
					turnRecordId: "trn_live_1",
					piTurnId: "turn-1",
					text: "Drafting plan",
					streamType: "text",
					timestamp: "2026-01-01T00:00:02Z",
				},
			}),
		);
		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.USAGE_UPDATED,
				instanceId: "agt_1",
				payload: {
					turnRecordId: "trn_live_1",
					piTurnId: "turn-1",
					usage: {
						input: 120,
						output: 24,
						cacheRead: 300,
						cacheWrite: 40,
						totalTokens: 484,
						cost: {
							input: 0.003,
							output: 0.0024,
							cacheRead: 0.0015,
							cacheWrite: 0.001,
							total: 0.0079,
						},
					},
					timestamp: "2026-01-01T00:00:02.500Z",
				},
			}),
		);
		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED,
				instanceId: "agt_1",
				payload: {
					turnRecordId: "trn_live_1",
					piTurnId: "turn-1",
					toolCallId: "tool-1",
					toolName: "run_tests",
					arguments: { suite: "unit" },
					timestamp: "2026-01-01T00:00:03Z",
				},
			}),
		);
		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED,
				instanceId: "agt_1",
				payload: {
					turnRecordId: "trn_live_1",
					piTurnId: "turn-1",
					toolCallId: "tool-1",
					toolName: "run_tests",
					result: { ok: true },
					isError: false,
					timestamp: "2026-01-01T00:00:04Z",
				},
			}),
		);

		expect(snapshot.turnState.activeTurn).toMatchObject({
			turnRecordId: "trn_live_1",
			assistant: {
				text: "Drafting plan",
				thinking: "Need to inspect the repo.\n",
			},
			usage: {
				input: 120,
				output: 24,
				cacheRead: 300,
				cacheWrite: 40,
				totalTokens: 484,
				cost: {
					input: 0.003,
					output: 0.0024,
					cacheRead: 0.0015,
					cacheWrite: 0.001,
					total: 0.0079,
				},
			},
			toolCalls: [
				expect.objectContaining({
					toolCallId: "tool-1",
					status: "completed",
					result: { ok: true },
				}),
			],
		});
		expect(getPrimaryPathActiveTurnOutput(snapshot.turnState.activeTurn)).toBe("Drafting plan");

		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED,
				instanceId: "agt_1",
				payload: {
					turnRecord: {
						id: "trn_live_1",
						instanceId: "agt_1",
						turnId: "generate_plan",
						turnType: "llm",
						status: "succeeded",
						attemptNumber: 1,
						parentTurnRecordId: null,
						pathType: "primary",
						forkPiEntryId: null,
						resultPiEntryId: "assistant-plan",
						turnResultMarkdown: "## Plan",
						errorSummary: null,
						startedAt: "2026-01-01T00:00:01Z",
						endedAt: "2026-01-01T00:00:05Z",
					},
					rootEntry: { entryId: "root-user", turnRecordId: null },
					currentLeaf: { entryId: "assistant-plan", turnRecordId: "trn_live_1" },
				},
			}),
		);

		expect(snapshot.turnState.currentTurnRecordId).toBeNull();
		expect(snapshot.turnState.activeTurn).toBeNull();
		expect(snapshot.currentLeaf).toEqual({ entryId: "assistant-plan", turnRecordId: "trn_live_1" });
	});

	it("does not surface thinking-only content as the main active-turn output", () => {
		let snapshot = applyPrimaryPathFrame(
			createSnapshot(),
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.TURN_STARTED,
				instanceId: "agt_1",
				payload: {
					turnRecord: {
						id: "trn_live_thinking",
						instanceId: "agt_1",
						turnId: "generate_plan",
						turnType: "llm",
						status: "running",
						attemptNumber: 1,
						parentTurnRecordId: null,
						pathType: "primary",
						forkPiEntryId: null,
						resultPiEntryId: null,
						turnResultMarkdown: null,
						errorSummary: null,
						startedAt: "2026-01-01T00:10:00Z",
						endedAt: null,
					},
				},
			}),
		);
		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
				instanceId: "agt_1",
				payload: {
					turnRecordId: "trn_live_thinking",
					piTurnId: "turn-thinking",
					text: "Thinking through the implementation.\n",
					streamType: "thinking",
					timestamp: "2026-01-01T00:10:01Z",
				},
			}),
		);

		expect(snapshot.turnState.activeTurn?.assistant.thinking).toBe(
			"Thinking through the implementation.\n",
		);
		expect(getPrimaryPathActiveTurnOutput(snapshot.turnState.activeTurn)).toBe("");
	});

	it("updates labels and turn annotations incrementally", () => {
		const annotation: ProcessTurnAnnotation = {
			id: "tan_1",
			instanceId: "agt_1",
			annotationType: "turn_milestone",
			annotationKey: "turn_milestone:trn_1",
			references: [{ kind: "turn_record", turnRecordId: "trn_1", role: "subject" }],
			payload: { turnId: "generate_plan" },
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		};
		let snapshot = applyPrimaryPathFrame(
			createSnapshot(),
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED,
				instanceId: "agt_1",
				payload: {
					change: "created",
					annotation,
				},
			}),
		);
		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.LABEL_CHANGED,
				instanceId: "agt_1",
				payload: {
					turnRecordId: null,
					piTurnId: null,
					targetId: "root-user",
					label: "approved-plan",
					timestamp: "2026-01-01T00:00:02Z",
				},
			}),
		);

		expect(snapshot.turnAnnotations).toEqual([annotation]);
		expect(snapshot.labels).toEqual({ "root-user": "approved-plan" });
	});
});
