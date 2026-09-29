import type { ProcessInput, ProcessLeafOutcomeSnapshot } from "@leitwerk-dev/domain";
import {
	type PrimaryPathActiveTurnSnapshot,
	type ProcessTimelineTurnSummary,
	type TurnTracePreview,
	timelinePresentationForTurnType,
} from "@leitwerk-dev/protocol";
import { createTestQuestionRequest } from "@leitwerk-dev/test-support/fixtures";
import { describe, expect, it } from "vitest";
import {
	buildChronicleProjection,
	extractChronicleReasoningTurnRecordIds,
} from "./chronicle-projection.js";

function makeTurnRecord(
	overrides: Partial<ProcessTimelineTurnSummary> = {},
): ProcessTimelineTurnSummary {
	return {
		id: "trn_1",
		turnId: "run_single_prompt",
		turnType: "llm",
		displayTurn: overrides.turnId ?? "run_single_prompt",
		outcome: "completed",
		summary: "Summary",
		output: "Output",
		turnResultMarkdown: "",
		pathType: "primary",
		createdAt: "2026-04-18T10:00:00.000Z",
		presentation: timelinePresentationForTurnType(overrides.turnType ?? "llm"),
		status: "completed",
		modelProfileId: null,
		attemptNumber: 1,
		parentTurnRecordId: null,
		startedAt: "2026-04-18T10:00:00.000Z",
		endedAt: "2026-04-18T10:01:00.000Z",
		actionSource: null,
		progress: null,
		...overrides,
	};
}

function makeTracePreview(overrides: Partial<TurnTracePreview> = {}): TurnTracePreview {
	return {
		turnRecordId: "trn_1",
		assistantTextPreview: "",
		assistantTextTruncated: false,
		thinkingPreview: "",
		thinkingPreviewTruncated: false,
		toolCallCount: 0,
		traceItemCount: 0,
		hasReasoningDetails: false,
		usage: null,
		piInput: null,
		...overrides,
	};
}

function makeInput(overrides: Partial<ProcessInput> = {}): ProcessInput {
	return {
		id: "inp_1",
		instanceId: "agt_1",
		sequence: 1,
		source: "app_steer",
		kind: "instruction",
		target: null,
		bodyMarkdown: "Please revise this.",
		receivedAt: "2026-04-18T10:01:00.000Z",
		consumedAt: null,
		...overrides,
	};
}

function makeSnapshot(
	overrides: Partial<ProcessLeafOutcomeSnapshot> = {},
): ProcessLeafOutcomeSnapshot {
	return {
		id: "los_1",
		instanceId: "agt_1",
		leafEntryId: "assistant-1",
		turnRecordId: "trn_1",
		rendererId: "test:leaf_outcome",
		schemaVersion: 1,
		props: { title: "Outcome" },
		fallbackMarkdown: "## Outcome",
		status: "ready",
		warningCode: null,
		warningMessage: null,
		anchoredAt: "2026-04-18T10:00:00.000Z",
		createdAt: "2026-04-18T10:00:01.000Z",
		...overrides,
	};
}

function makeActiveTurn(
	overrides: Partial<PrimaryPathActiveTurnSnapshot> = {},
): PrimaryPathActiveTurnSnapshot {
	return {
		turnRecordId: "trn_live",
		turnId: "run_single_prompt",
		turnType: "llm",
		pathType: "primary",
		startedAt: "2026-04-18T10:02:30.000Z",
		assistant: { text: "", thinking: "", lastUpdatedAt: null },
		toolCalls: [],
		traceItems: [],
		usage: null,
		eventWindowTruncated: false,
		...overrides,
	};
}

function buildProjection(overrides: Partial<Parameters<typeof buildChronicleProjection>[0]> = {}) {
	return buildChronicleProjection({
		turnRecords: [],
		inputs: [],
		leafOutcomeSnapshots: [],
		definesLeafOutcome: false,
		activeTurn: null,
		...overrides,
	});
}

function clusters(projection: ReturnType<typeof buildProjection>) {
	return projection.timelineItems.filter((item) => item.kind === "turn_cluster");
}

function liveRecord() {
	return makeTurnRecord({
		id: "trn_live",
		status: "in_progress",
		outcome: "in_progress",
		createdAt: "2026-04-18T10:03:00.000Z",
		endedAt: null,
	});
}

describe("buildChronicleProjection", () => {
	it("projects automatic-turn progress before its result", () => {
		const progress = {
			title: "Delivery progress",
			steps: [
				{ id: "validate", label: "Validate", status: "completed" as const },
				{ id: "publish", label: "Publish", status: "in_progress" as const },
			],
			links: [{ id: "pr", label: "PR #1", url: "https://example.test/pr/1" }],
		};
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ turnType: "automatic", progress, turnResultMarkdown: "Done" }),
			],
		});
		expect(clusters(projection)[0].sections.map((section) => section.kind)).toEqual([
			"turn_progress",
			"turn_result",
		]);
		expect(clusters(projection)[0].sections[0]).toMatchObject({ report: progress });
	});

	it("projects completed turns, operator inputs, and the live tail in chronicle order", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_done", turnResultMarkdown: "Shipped answer" }),
				makeTurnRecord({ id: "trn_review", createdAt: "2026-04-18T10:02:00.000Z" }),
				liveRecord(),
			],
			turnTracePreviewIndex: {
				trn_done: makeTracePreview({
					thinkingPreview: "Plan the response before answering.",
					toolCallCount: 1,
					traceItemCount: 2,
					hasReasoningDetails: true,
				}),
			},
			inputs: [makeInput(), makeInput({ id: "system", source: "system" })],
			activeTurn: makeActiveTurn({
				assistant: { text: "", thinking: "Still drafting", lastUpdatedAt: null },
			}),
		});
		expect(projection.turnRailItems.map((item) => item.turnRecordId)).toEqual([
			"trn_done",
			"trn_review",
			"trn_live",
		]);
		expect(projection.turnRailItems.at(-1)?.anchorId).toBe(projection.liveTail?.anchorId);
		expect(projection.initialFocusedTurnId).toBe("trn_live");
		expect(projection.initialAnchorId).toBe(projection.liveTail?.anchorId);
		expect(projection.timelineItems.map((item) => item.kind)).toEqual([
			"turn_cluster",
			"operator_input",
			"turn_cluster",
			"live_tail",
		]);
		expect(clusters(projection)[0]).toMatchObject({
			turnLabel: "run_single_prompt",
			pathLabel: "Continuing the main path",
			facts: { startedAt: "2026-04-18T10:00:00.000Z", endedAt: "2026-04-18T10:01:00.000Z" },
			sections: [
				{
					kind: "thinking_preview",
					preview: "Plan the response before answering.",
					toolCallCount: 1,
				},
				{ kind: "turn_result" },
			],
		});
		expect(projection.liveTail).toMatchObject({ state: "thinking", stateLabel: "Reasoning" });
		expect(extractChronicleReasoningTurnRecordIds(projection)).toEqual(["trn_done", "trn_live"]);
	});

	it("keeps app actions as triggering input without a duplicate operator-input item", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "decision", turnType: "human" }),
				makeTurnRecord({ id: "impl", startedAt: "2026-04-18T10:04:10.000Z" }),
			],
			inputs: [makeInput({ source: "action_prompt", consumedAt: "2026-04-18T10:04:05.000Z" })],
		});
		expect(projection.timelineItems.some((item) => item.kind === "operator_input")).toBe(false);
		expect(clusters(projection)[0]).toMatchObject({
			turnPresentation: "operator_decision",
			pathLabel: null,
		});
		expect(clusters(projection)[1].triggeringInput).toMatchObject({
			inputId: "inp_1",
			source: "action_prompt",
		});
	});

	it("does not classify external-trigger turns as operator decisions", () => {
		const projection = buildProjection({ turnRecords: [makeTurnRecord({ turnType: "external" })] });
		expect(clusters(projection)[0]).toMatchObject({
			isOperatorDecision: false,
			turnPresentation: "external_trigger",
		});
	});

	it.each([
		true,
		false,
	])("associates each turn with its starting input (consumed attribution: %s)", (consumed) => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({
					id: "first",
					startedAt: "2026-04-18T10:01:10.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
				makeTurnRecord({
					id: "second",
					startedAt: "2026-04-18T10:04:10.000Z",
					endedAt: "2026-04-18T10:05:00.000Z",
				}),
			],
			inputs: [
				makeInput({ id: "prompt", consumedAt: "2026-04-18T10:01:05.000Z" }),
				makeInput({
					id: "steer",
					sequence: 2,
					receivedAt: "2026-04-18T10:01:20.000Z",
					consumedAt: "2026-04-18T10:01:25.000Z",
				}),
				makeInput({
					id: "next",
					sequence: 3,
					receivedAt: "2026-04-18T10:04:00.000Z",
					consumedAt: consumed ? "2026-04-18T10:04:05.000Z" : null,
				}),
			],
		});
		expect(clusters(projection).map((item) => item.triggeringInput?.inputId)).toEqual([
			"prompt",
			"next",
		]);
	});

	it("falls back to the original user prompt when no consumed input exists", () => {
		const projection = buildProjection({
			turnRecords: [makeTurnRecord()],
			promptText: "Generated wrapper around user prompt",
			initialUserInputText: "Original user prompt",
		});
		expect(clusters(projection)[0].triggeringInput).toMatchObject({
			inputId: "chronicle-initial-prompt",
			source: "initial_prompt",
			bodyMarkdown: "Original user prompt",
		});
		expect(projection.promptItem?.text).toBe("Original user prompt");
	});

	it.each([
		"completed",
		"in_progress",
	] as const)("opens questions without a trace for a %s turn", (status) => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "unrelated" }),
				makeTurnRecord({ id: "question", status }),
			],
			activeTurn: status === "in_progress" ? makeActiveTurn({ turnRecordId: "question" }) : null,
		});
		expect(extractChronicleReasoningTurnRecordIds(projection)).toEqual(
			status === "in_progress" ? ["question"] : [],
		);
		expect(
			extractChronicleReasoningTurnRecordIds(projection, [
				createTestQuestionRequest({
					turnRecordId: "question",
					status: status === "in_progress" ? "open" : "answered",
				}),
			]),
		).toEqual(["question"]);
	});

	it("keeps model-only turns navigable and does not invent reasoning for unrelated turns", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "empty" }),
				makeTurnRecord({ id: "model", modelProfileId: "profile" }),
				makeTurnRecord({ id: "automatic", turnType: "automatic", modelProfileId: "profile" }),
			],
		});
		expect(extractChronicleReasoningTurnRecordIds(projection)).toEqual(["model"]);
	});

	it.each([
		{ toolCallCount: 2, traceItemCount: 3, hasReasoningDetails: true },
		{
			thinkingPreview: "… line 18\nline 19\nline 20",
			thinkingPreviewTruncated: true,
			traceItemCount: 20,
			hasReasoningDetails: true,
		},
	])("preserves compact trace details: %j", (preview) => {
		const projection = buildProjection({
			turnRecords: [makeTurnRecord()],
			turnTracePreviewIndex: { trn_1: makeTracePreview(preview) },
		});
		expect(clusters(projection)[0].sections[0]).toMatchObject({
			kind: "thinking_preview",
			preview: "thinkingPreview" in preview ? preview.thinkingPreview : "",
			previewTruncated: "thinkingPreviewTruncated" in preview,
			toolCallCount: preview.toolCallCount ?? 0,
			traceItemCount: preview.traceItemCount,
		});
		expect(extractChronicleReasoningTurnRecordIds(projection)).toEqual(["trn_1"]);
	});

	it("preserves Markdown indentation in the original prompt and compact model input", () => {
		const prompt = "    const value = 1;\n\n    return value;\n";
		const projection = buildProjection({
			turnRecords: [makeTurnRecord()],
			initialUserInputText: prompt,
			turnTracePreviewIndex: {
				trn_1: makeTracePreview({
					hasReasoningDetails: true,
					piInput: {
						createdAt: "2026-04-18T10:00:00.000Z",
						userInputPreview: prompt,
						partCount: 1,
					},
				}),
			},
		});
		expect(projection.promptItem?.text).toBe(prompt);
		expect(clusters(projection)[0].piInput).toMatchObject({
			fullPrompt: prompt,
			userInput: prompt,
		});
		expect(extractChronicleReasoningTurnRecordIds(projection)).toEqual(["trn_1"]);
	});

	it("prepends a prompt when supplied, and leaves an empty process empty", () => {
		const withPrompt = buildProjection({ turnRecords: [makeTurnRecord()], promptText: "Ship it" });
		expect(withPrompt.timelineItems[0]).toMatchObject({ kind: "prompt", text: "Ship it" });
		const empty = buildProjection();
		expect(empty.promptItem).toBeNull();
		expect(empty.timelineItems).toEqual([]);
		expect(empty.initialAnchorId).toBeNull();
	});

	it.each([
		[
			"line one\nline two\nline three\nline four\nline five",
			"line one\nline two\nline three\nline four\nline five",
		],
		[". <br>\n\n", ". <br>\n"],
	])("bounds live previews without changing full whitespace: %j", (thinking, preview) => {
		const projection = buildProjection({
			turnRecords: [liveRecord()],
			activeTurn: makeActiveTurn({ assistant: { text: "", thinking, lastUpdatedAt: null } }),
		});
		expect(projection.liveTail?.reasoningSection).toMatchObject({
			text: thinking,
			preview,
			previewTruncated: false,
		});
		expect(projection.liveTail?.copy).toBe(preview);
	});

	it("keeps a durable result even when it matches the assistant preview", () => {
		const text = "The garden notes are ready.";
		const projection = buildProjection({
			turnRecords: [makeTurnRecord({ turnResultMarkdown: text })],
			turnTracePreviewIndex: { trn_1: makeTracePreview({ assistantTextPreview: text }) },
		});
		expect(clusters(projection)[0].sections).toEqual([{ kind: "turn_result", markdown: text }]);
	});

	it.each([
		"ready",
		"capture_error",
	] as const)("shows the saved result only when the leaf outcome cannot render (%s)", (status) => {
		const projection = buildProjection({
			turnRecords: [makeTurnRecord({ turnResultMarkdown: "Saved result" })],
			turnTracePreviewIndex: {
				trn_1: makeTracePreview({ thinkingPreview: "Plan", hasReasoningDetails: true }),
			},
			leafOutcomeSnapshots: [makeSnapshot({ status, fallbackMarkdown: null })],
			definesLeafOutcome: true,
		});
		expect(clusters(projection)[0].sections.map((section) => section.kind)).toEqual(
			status === "ready" ? ["thinking_preview"] : ["thinking_preview", "turn_result"],
		);
		expect(projection.timelineItems[1]).toMatchObject({
			kind: "leaf_outcome",
			status,
			turnRecordId: "trn_1",
		});
		expect(projection.initialAnchorId).toBe("chronicle-leaf-outcome-los_1");
	});

	it("orders snapshots after matching turns and prefers the latest review snapshot", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord(),
				makeTurnRecord({ id: "review", createdAt: "2026-04-18T10:02:00.000Z" }),
			],
			leafOutcomeSnapshots: [
				makeSnapshot(),
				makeSnapshot({
					id: "review_snapshot",
					turnRecordId: "review",
					anchoredAt: "2026-04-18T10:03:00.000Z",
				}),
			],
			definesLeafOutcome: true,
		});
		expect(projection.timelineItems.map((item) => item.kind)).toEqual([
			"turn_cluster",
			"leaf_outcome",
			"turn_cluster",
			"leaf_outcome",
		]);
		expect(projection.initialFocusedTurnId).toBe("review");
		expect(projection.initialAnchorId).toBe("chronicle-leaf-outcome-review_snapshot");
	});

	it.each([
		"Thinking",
		"",
	])("shows running tools with or without live thinking (%s)", (thinking) => {
		const tool = {
			toolCallId: "tool_live",
			toolName: "read",
			status: "running" as const,
			startedAt: "2026-04-18T10:05:01.000Z",
			completedAt: null,
			arguments: { path: "README.md" },
			result: null,
			isError: false,
		};
		const projection = buildProjection({
			turnRecords: [liveRecord()],
			activeTurn: makeActiveTurn({
				assistant: { text: "Answer", thinking, lastUpdatedAt: null },
				toolCalls: [tool],
			}),
		});
		expect(projection.liveTail).toMatchObject({
			state: "tool_running",
			copy: "Running Read…",
			toolCall: tool,
			reasoningSection: { toolCallCount: 1 },
		});
	});

	it.each<PrimaryPathActiveTurnSnapshot["traceItems"]>([
		[
			{
				kind: "operational_event",
				eventType: "pi.error",
				severity: "error",
				title: "Error",
				message: "Failed",
				timestamp: "2026-04-18T10:03:00.000Z",
			},
		],
		[{ kind: "thinking", text: "Recorded thought" }],
		[{ kind: "thinking", text: " " }],
		[{ kind: "tool_call", toolCallId: "missing" }],
	])("only exposes displayable live trace activity: %j", (...traceItems) => {
		const projection = buildProjection({
			turnRecords: [{ ...liveRecord(), turnType: "automatic" }],
			activeTurn: makeActiveTurn({ traceItems }),
		});
		const item = traceItems[0];
		const expected =
			item.kind === "operational_event" || (item.kind === "thinking" && item.text.trim() !== "");
		expect(Boolean(projection.liveTail?.reasoningSection)).toBe(expected);
	});

	it("preserves reasoning when a live turn becomes a committed compact preview", () => {
		const thinking = "Reasoning visible before and after commit.";
		const live = buildProjection({
			turnRecords: [liveRecord()],
			activeTurn: makeActiveTurn({ assistant: { text: "", thinking, lastUpdatedAt: null } }),
		});
		const committed = buildProjection({
			turnRecords: [makeTurnRecord({ id: "trn_live" })],
			turnTracePreviewIndex: {
				trn_live: makeTracePreview({ thinkingPreview: thinking, hasReasoningDetails: true }),
			},
		});
		expect(live.liveTail?.reasoningSection?.text).toBe(thinking);
		expect(clusters(committed)[0].sections[0]).toMatchObject({ text: thinking });
	});

	it.each([
		true,
		false,
	])("only adds the leaf placeholder when the process defines one (%s)", (definesLeafOutcome) => {
		const projection = buildProjection({ turnRecords: [makeTurnRecord()], definesLeafOutcome });
		expect(projection.liveTail).toBeNull();
		expect(projection.timelineItems.map((item) => item.kind)).toEqual(
			definesLeafOutcome ? ["turn_cluster", "leaf_outcome_placeholder"] : ["turn_cluster"],
		);
		expect(projection.initialAnchorId).toBe(projection.turnRailItems[0].anchorId);
	});

	it.each([
		"completed",
		"aborted",
	] as const)("adds a terminal rail item for %s processes", (lifecycleStatus) => {
		const projection = buildProjection({ turnRecords: [makeTurnRecord()], lifecycleStatus });
		expect(projection.terminalRailItem).toEqual({
			terminalStatus: lifecycleStatus,
			anchorId: `chronicle-terminal-${lifecycleStatus}`,
			title: lifecycleStatus === "completed" ? "Completed" : "Aborted",
		});
		expect(projection.initialAnchorId).toBe(projection.terminalRailItem?.anchorId);
	});
});
