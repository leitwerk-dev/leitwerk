import {
	type PrimaryPathSnapshot,
	type PrimaryPathWsFrame,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import {
	replayPrimaryPathFramesAfterSnapshot,
	shouldReplayPrimaryPathFrameAfterSnapshot,
} from "./primary-path-replay.js";

function createSnapshot(overrides: Partial<PrimaryPathSnapshot> = {}): PrimaryPathSnapshot {
	return {
		instanceId: "agt_1",
		rebuiltAt: "2026-01-01T00:00:02.000Z",
		primaryPathEntries: [],
		currentLeaf: null,
		semanticEntryRefs: {
			plan: null,
			review: null,
			currentPrimaryPathLeaf: null,
			rootEntry: null,
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
		...overrides,
	};
}

function createTurnStartedFrame(sentAt: string): PrimaryPathWsFrame {
	return {
		protocol: "leitwerk/ws/v1",
		type: WS_PRIMARY_PATH_TYPES.TURN_STARTED,
		durability: "durable",
		sentAt,
		instanceId: "agt_1",
		payload: {
			turnRecord: {
				id: "trn_1",
				instanceId: "agt_1",
				turnId: "draft_poem",
				turnType: "llm",
				status: "running",
				attemptNumber: 1,
				parentTurnRecordId: null,
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				turnResultMarkdown: null,
				errorSummary: null,
				errorClass: null,
				startedAt: "2026-01-01T00:00:02.500Z",
				endedAt: null,
				modelProfileId: null,
			},
		},
	};
}

function createAssistantPartialFrame(sentAt: string, text: string): PrimaryPathWsFrame {
	return {
		protocol: "leitwerk/ws/v1",
		type: WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
		durability: "ephemeral",
		sentAt,
		instanceId: "agt_1",
		payload: {
			turnRecordId: "trn_1",
			piTurnId: "turn-1",
			text,
			streamType: "text",
			timestamp: sentAt,
		},
	};
}

describe("shouldReplayPrimaryPathFrameAfterSnapshot", () => {
	it("replays only frames sent after the snapshot was rebuilt", () => {
		const snapshot = createSnapshot({ rebuiltAt: "2026-01-01T00:00:02.000Z" });
		expect(
			shouldReplayPrimaryPathFrameAfterSnapshot(
				createAssistantPartialFrame("2026-01-01T00:00:01.000Z", "before"),
				snapshot,
			),
		).toBe(false);
		expect(
			shouldReplayPrimaryPathFrameAfterSnapshot(
				createAssistantPartialFrame("2026-01-01T00:00:02Z", "same instant"),
				snapshot,
			),
		).toBe(false);
		expect(
			shouldReplayPrimaryPathFrameAfterSnapshot(
				createAssistantPartialFrame("2026-01-01T00:00:03.000Z", "after"),
				snapshot,
			),
		).toBe(true);
	});
});

describe("replayPrimaryPathFramesAfterSnapshot", () => {
	it("replays buffered frames on top of a stale snapshot", () => {
		const snapshot = createSnapshot({ rebuiltAt: "2026-01-01T00:00:02.000Z" });
		const result = replayPrimaryPathFramesAfterSnapshot(snapshot, [
			createTurnStartedFrame("2026-01-01T00:00:03.000Z"),
			createAssistantPartialFrame("2026-01-01T00:00:04.000Z", "hello"),
		]);

		expect(result.turnState.currentTurnRecordId).toBe("trn_1");
		expect(result.turnState.activeTurn?.turnRecordId).toBe("trn_1");
		expect(result.turnState.activeTurn?.assistant.text).toBe("hello");
	});

	it("does not duplicate frames already reflected in the snapshot", () => {
		const snapshot = createSnapshot({
			rebuiltAt: "2026-01-01T00:00:05.000Z",
			turnState: {
				currentTurnRecordId: "trn_1",
				workerState: "busy",
				isStreaming: true,
				activeTurn: {
					turnRecordId: "trn_1",
					turnId: "draft_poem",
					turnType: "llm",
					pathType: "primary",
					startedAt: "2026-01-01T00:00:02.500Z",
					assistant: {
						text: "hello",
						thinking: "",
						lastUpdatedAt: "2026-01-01T00:00:04.000Z",
					},
					toolCalls: [],
					traceItems: [],
					eventWindowTruncated: false,
				},
			},
		});
		const result = replayPrimaryPathFramesAfterSnapshot(snapshot, [
			createAssistantPartialFrame("2026-01-01T00:00:04.000Z", "hello"),
		]);

		expect(result.turnState.activeTurn?.assistant.text).toBe("hello");
	});
});
