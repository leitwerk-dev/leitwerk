import type { ProcessTurnAnnotation, ProcessTurnRecord } from "@leitwerk-dev/domain";
import {
	emptyCompactTurnSummary,
	type PrimaryPathUiSnapshot,
	type PrimaryPathWsFrame,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import { applyPrimaryPathFrame, getPrimaryPathActiveTurnOutput } from "./primary-path-detail.js";
import {
	replayPrimaryPathFramesAfterSnapshot,
	shouldReplayPrimaryPathFrameAfterSnapshot,
} from "./primary-path-replay.js";

const timestamp = "2026-01-01T00:00:02.000Z";
const turnRecord: ProcessTurnRecord = {
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
	startedAt: timestamp,
	endedAt: null,
	modelProfileId: null,
};

function createSnapshot(): PrimaryPathUiSnapshot {
	return {
		instanceId: "agt_1",
		rebuiltAt: timestamp,
		throughEventSequence: 0,
		entryCount: 1,
		entriesOmitted: true,
		primaryPathEntries: [{ id: "root-user", parentId: null, type: "message", timestamp }],
		currentLeaf: { entryId: "root-user", turnRecordId: null },
		semanticEntryRefs: {
			rootEntry: { entryId: "root-user", turnRecordId: null },
			currentPrimaryPathLeaf: { entryId: "root-user", turnRecordId: null },
			plan: null,
			review: null,
		},
		labels: {},
		turnAnnotations: [],
		detailRail: { keyPoints: [], futureTurns: [], currentPosition: null },
		turnState: {
			currentTurnRecordId: null,
			workerState: "busy",
			isStreaming: false,
			activeTurn: null,
		},
	};
}

function createFrame(
	frame: Omit<PrimaryPathWsFrame, "protocol" | "durability" | "sentAt" | "instanceId">,
	durability: "durable" | "ephemeral" = "durable",
): PrimaryPathWsFrame {
	return {
		protocol: "leitwerk/ws/v1",
		durability,
		sentAt: timestamp,
		instanceId: "agt_1",
		...frame,
	};
}

const start = createFrame({
	type: WS_PRIMARY_PATH_TYPES.TURN_STARTED,
	eventSequence: 1,
	payload: { turnRecord },
});
function summaryFrame(
	eventSequence: number,
	turnRecordId = "trn_1",
	throughEventSequence = eventSequence,
) {
	return createFrame(
		{
			type: WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED,
			eventSequence,
			payload: {
				turnRecordId,
				summary: {
					...emptyCompactTurnSummary(),
					throughEventSequence,
					assistant: { text: "hello", thinking: "Thinking", lastUpdatedAt: timestamp },
				},
			},
		},
		"ephemeral",
	);
}

const commit = createFrame({
	type: WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED,
	eventSequence: 4,
	payload: {
		turnRecord: {
			...turnRecord,
			status: "succeeded",
			resultPiEntryId: "assistant-poem",
			endedAt: timestamp,
		},
		rootEntry: { entryId: "root-user", turnRecordId: null },
		currentLeaf: { entryId: "assistant-poem", turnRecordId: "trn_1" },
	},
});

describe("compact primary-path frames", () => {
	it("applies turn start, bounded summaries, and correlated completion", () => {
		const started = applyPrimaryPathFrame(createSnapshot(), start);
		expect(started.turnState).toMatchObject({
			currentTurnRecordId: "trn_1",
			isStreaming: true,
			activeTurn: { summaryPending: true },
		});
		const snapshot = applyPrimaryPathFrame(started, summaryFrame(3));
		expect(snapshot.turnState.activeTurn).toMatchObject({
			turnRecordId: "trn_1",
			summaryPending: false,
			throughEventSequence: 3,
		});
		expect(getPrimaryPathActiveTurnOutput(snapshot.turnState.activeTurn)).toBe("hello");
		expect(
			getPrimaryPathActiveTurnOutput({
				assistant: { text: "", thinking: "Thinking", lastUpdatedAt: timestamp },
			}),
		).toBe("");
		const unrelatedCommit = createFrame({
			type: WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED,
			eventSequence: 4,
			payload: { turnRecord: { ...turnRecord, id: "other" }, rootEntry: null, currentLeaf: null },
		});
		expect(applyPrimaryPathFrame(snapshot, unrelatedCommit)).toBe(snapshot);
		const completed = applyPrimaryPathFrame(snapshot, commit);
		expect(completed.turnState).toMatchObject({
			currentTurnRecordId: null,
			isStreaming: false,
			activeTurn: null,
		});
		expect(completed.currentLeaf).toEqual({ entryId: "assistant-poem", turnRecordId: "trn_1" });
		expect(completed.throughEventSequence).toBe(4);
		expect(snapshot.turnState.activeTurn?.turnRecordId).toBe("trn_1");
	});

	it("rejects summaries without a matching turn or a newer sequence", () => {
		const snapshot = applyPrimaryPathFrame(
			applyPrimaryPathFrame(createSnapshot(), start),
			summaryFrame(3),
		);
		for (const frame of [summaryFrame(2), summaryFrame(4, "other"), summaryFrame(4, "trn_1", 2)])
			expect(applyPrimaryPathFrame(snapshot, frame)).toBe(snapshot);
		const empty = createSnapshot();
		expect(applyPrimaryPathFrame(empty, summaryFrame(4))).toBe(empty);
	});

	it("ignores full-activity compatibility frames without advancing the compact boundary", () => {
		const snapshot = applyPrimaryPathFrame(createSnapshot(), start);
		for (const frame of [
			{
				type: WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
				payload: {
					turnRecordId: "trn_1",
					piTurnId: null,
					text: "raw text",
					streamType: "text",
					timestamp,
				},
			},
			{
				type: WS_PRIMARY_PATH_TYPES.USAGE_UPDATED,
				payload: {
					turnRecordId: "trn_1",
					piTurnId: null,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: null },
					timestamp,
				},
			},
			{
				type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED,
				payload: {
					turnRecordId: "trn_1",
					piTurnId: null,
					toolCallId: "tool",
					toolName: "read",
					arguments: {},
					timestamp,
				},
			},
			{
				type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED,
				payload: {
					turnRecordId: "trn_1",
					piTurnId: null,
					toolCallId: "tool",
					toolName: "read",
					result: "raw result",
					isError: false,
					timestamp,
				},
			},
		] as const)
			expect(
				applyPrimaryPathFrame(snapshot, createFrame({ ...frame, eventSequence: 2 }, "ephemeral")),
				frame.type,
			).toBe(snapshot);
	});

	it("updates labels, annotations, and leaf references without replacing active state", () => {
		const annotation: ProcessTurnAnnotation = {
			id: "tan_1",
			instanceId: "agt_1",
			annotationType: "turn_milestone",
			annotationKey: "turn_milestone:trn_1",
			references: [{ kind: "turn_record", turnRecordId: "trn_1", role: "subject" }],
			payload: { turnId: "draft_poem" },
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		let snapshot = applyPrimaryPathFrame(createSnapshot(), start);
		const active = snapshot.turnState.activeTurn;
		for (const label of ["approved-poem", null]) {
			snapshot = applyPrimaryPathFrame(
				snapshot,
				createFrame({
					type: WS_PRIMARY_PATH_TYPES.LABEL_CHANGED,
					payload: { turnRecordId: null, piTurnId: null, targetId: "root-user", label, timestamp },
				}),
			);
			expect(snapshot.labels).toEqual(label ? { "root-user": label } : {});
		}
		for (const change of ["created", "updated"] as const) {
			snapshot = applyPrimaryPathFrame(
				snapshot,
				createFrame({
					type: WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED,
					payload: { change, annotation },
				}),
			);
			expect(snapshot.turnAnnotations).toEqual([annotation]);
		}
		snapshot = applyPrimaryPathFrame(
			snapshot,
			createFrame({
				type: WS_PRIMARY_PATH_TYPES.CHANGED,
				payload: { rootEntry: null, currentLeaf: null },
			}),
		);
		expect(snapshot.currentLeaf).toBeNull();
		expect(snapshot.semanticEntryRefs.rootEntry).toBeNull();
		expect(snapshot.turnState.activeTurn).toBe(active);
	});
});

describe("primary-path replay", () => {
	it("uses timestamps only for unsequenced metadata and sequences for activity", () => {
		const snapshot = { ...createSnapshot(), throughEventSequence: 3 };
		for (const [sentAt, expected] of [
			["2026-01-01T00:00:01Z", false],
			["2026-01-01T00:00:02Z", false],
			["2026-01-01T00:00:03Z", true],
		] as const)
			expect(shouldReplayPrimaryPathFrameAfterSnapshot({ sentAt }, snapshot)).toBe(expected);
		expect(
			shouldReplayPrimaryPathFrameAfterSnapshot(
				{ sentAt: "2026-01-01T00:00:01Z", eventSequence: 4 },
				snapshot,
			),
		).toBe(true);
		expect(
			shouldReplayPrimaryPathFrameAfterSnapshot(
				{ sentAt: "2026-01-01T00:00:03Z", eventSequence: 3 },
				snapshot,
			),
		).toBe(false);
	});

	it("orders buffered frames and does not replay activity already in a detached snapshot", () => {
		const snapshot = createSnapshot();
		const result = replayPrimaryPathFramesAfterSnapshot(snapshot, [summaryFrame(3), start]);
		expect(result.turnState.currentTurnRecordId).toBe("trn_1");
		expect(result.turnState.activeTurn?.assistant.text).toBe("hello");
		expect(snapshot.turnState.activeTurn).toBeNull();
		const replayed = replayPrimaryPathFramesAfterSnapshot(result, [start, summaryFrame(3)]);
		expect(replayed).toEqual(result);
		expect(replayed.turnState.activeTurn?.assistant).not.toBe(
			result.turnState.activeTurn?.assistant,
		);
	});
});
