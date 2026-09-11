import type {
	ProcessInput,
	ProcessLeafOutcomeSnapshot,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
} from "@leitwerk-dev/domain";
import {
	type PrimaryPathActiveTurnSnapshot,
	type ProcessTimelineTurnSummary,
	type TurnTracePreview,
	type TurnTraceSnapshot,
	timelinePresentationForTurnType,
} from "@leitwerk-dev/protocol";
import { createTestQuestionRequest } from "@leitwerk-dev/test-support/fixtures";
import { describe, expect, it } from "vitest";

type TurnRecordView = ProcessTimelineTurnSummary;

import {
	buildChronicleProjection,
	extractChronicleReasoningDetailEntries,
} from "./chronicle-projection.js";

function makeTurnRecord(overrides: Partial<TurnRecordView> = {}): TurnRecordView {
	const turnId = overrides.turnId ?? "run_single_prompt";
	return {
		id: overrides.id ?? "trn_1",
		turnId,
		turnType: overrides.turnType ?? "llm",
		displayTurn: overrides.displayTurn ?? turnId,
		outcome: overrides.outcome ?? "completed",
		summary: overrides.summary ?? "Summary",
		output: overrides.output ?? "Output",
		turnResultMarkdown: overrides.turnResultMarkdown ?? "",
		pathType: overrides.pathType ?? "primary",
		createdAt: overrides.createdAt ?? "2026-04-18T10:00:00.000Z",
		presentation:
			overrides.presentation ?? timelinePresentationForTurnType(overrides.turnType ?? "llm"),
		status: overrides.status ?? "completed",
		modelProfileId: overrides.modelProfileId ?? null,
		attemptNumber: overrides.attemptNumber ?? 1,
		parentTurnRecordId: overrides.parentTurnRecordId ?? null,
		startedAt: overrides.startedAt ?? "2026-04-18T10:00:00.000Z",
		endedAt: overrides.endedAt ?? "2026-04-18T10:01:00.000Z",
		actionSource: overrides.actionSource ?? null,
		progress: overrides.progress ?? null,
	};
}

function makeDurableTurnRecord(overrides: Partial<ProcessTurnRecord> = {}): ProcessTurnRecord {
	const id = overrides.id ?? "trn_1";
	const turnType = overrides.turnType ?? "llm";
	const workerOwned = turnType === "llm" || turnType === "automatic";
	return {
		id,
		instanceId: overrides.instanceId ?? "agt_1",
		turnId: overrides.turnId ?? "run_single_prompt",
		turnType,
		status: overrides.status ?? "succeeded",
		attemptNumber: overrides.attemptNumber ?? 1,
		parentTurnRecordId: overrides.parentTurnRecordId ?? null,
		pathType: overrides.pathType ?? "primary",
		forkPiEntryId: overrides.forkPiEntryId ?? null,
		turnStartRecordId: overrides.turnStartRecordId ?? (workerOwned ? `tsr_${id}` : null),
		acceptedWorkerLeaseId: overrides.acceptedWorkerLeaseId ?? (workerOwned ? `wls_${id}` : null),
		resultPiEntryId: overrides.resultPiEntryId ?? null,
		modelProfileId: overrides.modelProfileId ?? null,
		turnResultMarkdown: overrides.turnResultMarkdown ?? null,
		errorSummary: overrides.errorSummary ?? null,
		errorClass: overrides.errorClass ?? null,
		startedAt: overrides.startedAt ?? "2026-04-18T10:00:00.000Z",
		endedAt: overrides.endedAt ?? "2026-04-18T10:01:00.000Z",
	};
}

function makePiInput(fullPrompt: string, createdAt = "2026-04-18T10:00:00.000Z") {
	return {
		parts: [
			{
				role: "user" as const,
				text: fullPrompt,
				createdAt,
			},
		],
		fullPrompt,
		createdAt,
	};
}

function makeTrace(overrides: Partial<TurnTraceSnapshot> = {}): TurnTraceSnapshot {
	return {
		assistant: {
			text: overrides.assistant?.text ?? "",
			thinking: overrides.assistant?.thinking ?? "",
			lastUpdatedAt: overrides.assistant?.lastUpdatedAt ?? null,
		},
		toolCalls: overrides.toolCalls ?? [],
		traceItems: overrides.traceItems ?? [],
		usage: overrides.usage ?? null,
		piInput: overrides.piInput ?? null,
	};
}

function makeTracePreview(overrides: Partial<TurnTracePreview> = {}): TurnTracePreview {
	return {
		turnRecordId: overrides.turnRecordId ?? "trn_1",
		assistantTextPreview: overrides.assistantTextPreview ?? "",
		assistantTextTruncated: overrides.assistantTextTruncated ?? false,
		thinkingPreview: overrides.thinkingPreview ?? "",
		thinkingPreviewTruncated: overrides.thinkingPreviewTruncated ?? false,
		toolCallCount: overrides.toolCallCount ?? 0,
		traceItemCount: overrides.traceItemCount ?? 0,
		hasReasoningDetails: overrides.hasReasoningDetails ?? false,
		usage: overrides.usage ?? null,
		piInput: overrides.piInput ?? null,
	};
}

function makeInput(overrides: Partial<ProcessInput> = {}): ProcessInput {
	return {
		id: overrides.id ?? "inp_1",
		instanceId: overrides.instanceId ?? "agt_1",
		sequence: overrides.sequence ?? 1,
		source: overrides.source ?? "app_steer",
		kind: overrides.kind ?? "instruction",
		target: overrides.target ?? null,
		bodyMarkdown: overrides.bodyMarkdown ?? "Please revise this.",
		receivedAt: overrides.receivedAt ?? "2026-04-18T10:01:00.000Z",
		consumedAt: overrides.consumedAt ?? null,
	};
}

function makeTurnAnnotation(
	overrides: Partial<ProcessTurnAnnotation> & { turnRecordId?: string } = {},
): ProcessTurnAnnotation {
	const turnRecordId = overrides.turnRecordId ?? "trn_1";
	return {
		id: overrides.id ?? `ann_${turnRecordId}`,
		instanceId: overrides.instanceId ?? "agt_1",
		annotationType: overrides.annotationType ?? "acceptance_state",
		annotationKey: overrides.annotationKey ?? `acceptance_state:${turnRecordId}`,
		references: overrides.references ?? [{ kind: "turn_record", turnRecordId, role: "subject" }],
		payload: overrides.payload ?? {},
		createdAt: overrides.createdAt ?? "2026-04-18T10:01:00.000Z",
		updatedAt: overrides.updatedAt ?? "2026-04-18T10:01:00.000Z",
	};
}

function makeSnapshot(
	overrides: Partial<ProcessLeafOutcomeSnapshot> = {},
): ProcessLeafOutcomeSnapshot {
	return {
		id: overrides.id ?? "los_1",
		instanceId: overrides.instanceId ?? "agt_1",
		leafEntryId: overrides.leafEntryId ?? "assistant-1",
		turnRecordId: overrides.turnRecordId ?? "trn_1",
		rendererId: overrides.rendererId ?? "test:leaf_outcome",
		schemaVersion: overrides.schemaVersion ?? 1,
		props: overrides.props ?? { title: "Outcome" },
		fallbackMarkdown: overrides.fallbackMarkdown ?? "## Outcome",
		status: overrides.status ?? "ready",
		warningCode: overrides.warningCode ?? null,
		warningMessage: overrides.warningMessage ?? null,
		anchoredAt: overrides.anchoredAt ?? "2026-04-18T10:00:00.000Z",
		createdAt: overrides.createdAt ?? "2026-04-18T10:00:01.000Z",
	};
}

function makeActiveTurn(
	overrides: Partial<PrimaryPathActiveTurnSnapshot> = {},
): PrimaryPathActiveTurnSnapshot {
	return {
		turnRecordId: overrides.turnRecordId ?? "trn_live",
		turnId: overrides.turnId ?? "run_single_prompt",
		turnType: overrides.turnType ?? "llm",
		pathType: overrides.pathType ?? "primary",
		startedAt: overrides.startedAt ?? "2026-04-18T10:02:30.000Z",
		assistant: {
			text: overrides.assistant?.text ?? "",
			thinking: overrides.assistant?.thinking ?? "",
			lastUpdatedAt: overrides.assistant?.lastUpdatedAt ?? null,
		},
		toolCalls: overrides.toolCalls ?? [],
		traceItems: overrides.traceItems ?? [],
		usage: overrides.usage ?? null,
		eventWindowTruncated: overrides.eventWindowTruncated ?? false,
	};
}

type ProjectionOverrides = Partial<Parameters<typeof buildChronicleProjection>[0]> & {
	durableTurnRecords?: readonly ProcessTurnRecord[];
	turnAnnotations?: readonly ProcessTurnAnnotation[];
};

function buildProjection(overrides: ProjectionOverrides = {}) {
	const { durableTurnRecords = [], turnAnnotations: _turnAnnotations, ...input } = overrides;
	const lineageById = new Map(durableTurnRecords.map((record) => [record.id, record]));
	const turnRecords = (input.turnRecords ?? []).map((turn) => {
		const lineage = lineageById.get(turn.id);
		return lineage
			? {
					...turn,
					attemptNumber: lineage.attemptNumber,
					parentTurnRecordId: lineage.parentTurnRecordId,
					startedAt: lineage.startedAt,
					endedAt: lineage.endedAt,
				}
			: turn;
	});
	return buildChronicleProjection({
		turnTraceIndex: {},
		inputs: [],
		leafOutcomeSnapshots: [],
		definesLeafOutcome: false,
		activeTurn: null,
		...input,
		turnRecords,
	});
}

describe("buildChronicleProjection", () => {
	it("projects automatic-turn progress before its result", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({
					turnType: "automatic",
					progress: {
						title: "Delivery progress",
						steps: [
							{ id: "validate", label: "Validate", status: "completed" },
							{ id: "publish", label: "Publish", status: "in_progress" },
						],
						links: [{ id: "pr", label: "PR #1", url: "https://example.test/pr/1" }],
					},
				}),
			],
		});
		const cluster = projection.timelineItems.find((item) => item.kind === "turn_cluster");
		expect(cluster?.kind).toBe("turn_cluster");
		if (!cluster || cluster.kind !== "turn_cluster") throw new Error("Expected turn cluster");
		expect(cluster.sections[0]).toMatchObject({
			kind: "turn_progress",
			report: { title: "Delivery progress" },
		});
	});

	it("projects completed turns, operator inputs, and the live tail in chronicle order", () => {
		const completed = makeTurnRecord({
			id: "trn_done",
			createdAt: "2026-04-18T10:00:00.000Z",
			output: "Shipped answer",
			turnResultMarkdown: "## Final\n\nShipped answer with context",
		});
		const review = makeTurnRecord({
			id: "trn_review",
			turnId: "run_review",
			displayTurn: "run_review",
			createdAt: "2026-04-18T10:02:00.000Z",
			output: "Looks good",
		});
		const active = makeTurnRecord({
			id: "trn_live",
			status: "in_progress",
			outcome: "in_progress",
			createdAt: "2026-04-18T10:03:00.000Z",
		});

		const projection = buildProjection({
			turnRecords: [completed, review, active],
			turnTraceIndex: {
				trn_done: makeTrace({
					assistant: {
						text: "Shipped answer",
						thinking: "Plan the response before answering.",
						lastUpdatedAt: "2026-04-18T10:00:00.000Z",
					},
					toolCalls: [
						{
							toolCallId: "tool_1",
							toolName: "read",
							status: "completed",
							startedAt: "2026-04-18T09:59:55.000Z",
							completedAt: "2026-04-18T09:59:58.000Z",
							arguments: { path: "README.md" },
							result: { bytes: 128 },
							isError: false,
						},
					],
					traceItems: [
						{ kind: "thinking", text: "Plan the response before answering." },
						{ kind: "tool_call", toolCallId: "tool_1" },
					],
				}),
				trn_review: makeTrace({
					assistant: {
						text: "Looks good",
						thinking: "",
						lastUpdatedAt: "2026-04-18T10:02:00.000Z",
					},
				}),
			},
			inputs: [
				makeInput({
					id: "inp_operator",
					receivedAt: "2026-04-18T10:01:00.000Z",
					bodyMarkdown: "Please tighten the answer.",
				}),
				makeInput({
					id: "inp_system",
					source: "system",
					receivedAt: "2026-04-18T10:01:30.000Z",
					bodyMarkdown: "system noise",
				}),
			],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: makeActiveTurn({
				assistant: {
					text: "",
					thinking: "Still drafting the answer",
					lastUpdatedAt: "2026-04-18T10:03:10.000Z",
				},
				traceItems: [{ kind: "thinking", text: "Still drafting the answer" }],
			}),
		});

		expect(projection.turnRailItems.map((item) => item.turnRecordId)).toEqual([
			"trn_done",
			"trn_review",
			"trn_live",
		]);
		expect(projection.turnRailItems.at(-1)?.anchorId).toBe(projection.liveTail?.anchorId);
		expect(projection.turnRailItems.at(-1)?.turnLabel).toBe("run_single_prompt");
		expect(projection.initialFocusedTurnId).toBe("trn_live");
		expect(projection.initialAnchorId).toBe(projection.liveTail?.anchorId ?? null);
		expect(projection.timelineItems.map((item) => item.kind)).toEqual([
			"turn_cluster",
			"operator_input",
			"turn_cluster",
			"live_tail",
		]);

		const firstCluster = projection.timelineItems[0];
		expect(firstCluster).toMatchObject({
			kind: "turn_cluster",
			turnRecordId: "trn_done",
			turnLabel: "run_single_prompt",
			pathLabel: "Continuing the main path",
		});
		if (firstCluster.kind !== "turn_cluster") {
			throw new Error("expected a turn cluster");
		}
		expect(firstCluster.sections.map((section) => section.kind)).toEqual([
			"thinking_preview",
			"turn_result",
		]);
		expect(firstCluster.sections[0]).toMatchObject({
			kind: "thinking_preview",
			preview: "Plan the response before answering.",
			previewTruncated: false,
			toolCallCount: 1,
		});

		expect(projection.liveTail).toMatchObject({
			turnRecordId: "trn_live",
			turnLabel: "run_single_prompt",
			pathLabel: "Continuing the main path",
			state: "thinking",
			stateLabel: "Reasoning",
		});
	});

	it("keeps app actions as triggering input without rendering a duplicate operator-input item", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({
					id: "trn_decision",
					turnId: "implementation_decision",
					displayTurn: "request_revision",
					turnType: "human",
					presentation: "operator_decision",
					createdAt: "2026-04-18T10:02:00.000Z",
					output: "Revision notes:\nPlease tighten the implementation.",
					turnResultMarkdown: "",
				}),
				makeTurnRecord({
					id: "trn_impl",
					turnId: "implement",
					createdAt: "2026-04-18T10:05:00.000Z",
					output: "Updated implementation",
				}),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_decision",
					turnId: "implementation_decision",
					turnType: "human",
					startedAt: "2026-04-18T10:02:00.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
				makeDurableTurnRecord({
					id: "trn_impl",
					turnId: "implement",
					turnType: "llm",
					startedAt: "2026-04-18T10:04:10.000Z",
					endedAt: "2026-04-18T10:05:00.000Z",
				}),
			],
			turnTraceIndex: {
				trn_impl: makeTrace({
					assistant: { thinking: "Apply the revision", text: "", lastUpdatedAt: null },
				}),
			},
			inputs: [
				makeInput({
					id: "inp_action",
					source: "action_prompt",
					bodyMarkdown: "Please tighten the implementation.",
					receivedAt: "2026-04-18T10:03:00.000Z",
					consumedAt: "2026-04-18T10:04:05.000Z",
				}),
			],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const operatorInputs = projection.timelineItems.filter(
			(item) => item.kind === "operator_input",
		);
		expect(operatorInputs).toHaveLength(0);

		const [decisionCluster] = projection.timelineItems.filter(
			(item) => item.kind === "turn_cluster" && item.turnRecordId === "trn_decision",
		);
		expect(decisionCluster).toMatchObject({
			kind: "turn_cluster",
			turnPresentation: "operator_decision",
			pathLabel: null,
		});

		const entries = extractChronicleReasoningDetailEntries(projection);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.turnRecordId).toBe("trn_impl");
		expect(entries[0]?.triggeringInput).toMatchObject({
			inputId: "inp_action",
			source: "action_prompt",
			receivedAt: "2026-04-18T10:03:00.000Z",
			consumedAt: "2026-04-18T10:04:05.000Z",
		});
	});

	it("does not classify external-trigger chronicle turns as operator decisions", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({
					id: "trn_ext",
					turnId: "implementation_review",
					displayTurn: "await_external_review",
					turnType: "external",
					presentation: "external_trigger",
					createdAt: "2026-04-18T10:02:00.000Z",
					output: "Waiting for the external trigger.",
				}),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_ext",
					turnId: "implementation_review",
					turnType: "external",
					startedAt: "2026-04-18T10:02:00.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
			],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const [cluster] = projection.timelineItems.filter((item) => item.kind === "turn_cluster");
		expect(cluster).toMatchObject({
			turnRecordId: "trn_ext",
			isOperatorDecision: false,
			turnPresentation: "external_trigger",
		});
	});

	it("associates each reasoning turn with the input that actually started it", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_1", createdAt: "2026-04-18T10:02:00.000Z" }),
				makeTurnRecord({ id: "trn_2", createdAt: "2026-04-18T10:05:00.000Z" }),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_1",
					startedAt: "2026-04-18T10:01:10.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
				makeDurableTurnRecord({
					id: "trn_2",
					startedAt: "2026-04-18T10:04:10.000Z",
					endedAt: "2026-04-18T10:05:00.000Z",
				}),
			],
			turnTraceIndex: {
				trn_1: makeTrace({ assistant: { thinking: "First pass", text: "", lastUpdatedAt: null } }),
				trn_2: makeTrace({ assistant: { thinking: "Second pass", text: "", lastUpdatedAt: null } }),
			},
			inputs: [
				makeInput({
					id: "inp_prompt_1",
					sequence: 1,
					bodyMarkdown: "Prompt one",
					receivedAt: "2026-04-18T10:01:00.000Z",
					consumedAt: "2026-04-18T10:01:05.000Z",
				}),
				makeInput({
					id: "inp_steer_same_turn",
					sequence: 2,
					bodyMarkdown: "Late steer",
					receivedAt: "2026-04-18T10:01:20.000Z",
					consumedAt: "2026-04-18T10:01:25.000Z",
				}),
				makeInput({
					id: "inp_prompt_2",
					sequence: 3,
					bodyMarkdown: "Prompt two",
					receivedAt: "2026-04-18T10:04:00.000Z",
					consumedAt: "2026-04-18T10:04:05.000Z",
				}),
			],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const clusters = projection.timelineItems.filter(
			(item) => item.kind === "turn_cluster",
		) as Array<(typeof projection.timelineItems)[number] & { kind: "turn_cluster" }>;
		expect(clusters).toHaveLength(2);
		expect(clusters[0]?.triggeringInput?.inputId).toBe("inp_prompt_1");
		expect(clusters[0]?.triggeringInput?.bodyMarkdown).toBe("Prompt one");
		expect(clusters[1]?.triggeringInput?.inputId).toBe("inp_prompt_2");
		expect(clusters[1]?.triggeringInput?.bodyMarkdown).toBe("Prompt two");
	});

	it("falls back to the initial prompt when the first reasoning turn has no consumed input row", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({
					id: "trn_1",
					createdAt: "2026-04-18T10:02:00.000Z",
				}),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_1",
					startedAt: "2026-04-18T10:01:10.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
			],
			turnTraceIndex: {
				trn_1: makeTrace({
					assistant: { thinking: "Inspect the repo", text: "", lastUpdatedAt: null },
				}),
			},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
			promptText: "Generated process prompt around Original user prompt",
			initialUserInputText: "Original user prompt",
			promptCreatedAt: "2026-04-18T10:01:00.000Z",
		});

		const entries = extractChronicleReasoningDetailEntries(projection);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.triggeringInput).toMatchObject({
			inputId: "chronicle-initial-prompt",
			source: "initial_prompt",
			sourceLabel: "Initial prompt",
			bodyMarkdown: "Original user prompt",
		});
	});

	it("falls back to the latest received operator input when a later turn lacks consumed attribution", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_1", createdAt: "2026-04-18T10:02:00.000Z" }),
				makeTurnRecord({ id: "trn_2", createdAt: "2026-04-18T10:05:00.000Z" }),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_1",
					startedAt: "2026-04-18T10:01:10.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
				makeDurableTurnRecord({
					id: "trn_2",
					startedAt: "2026-04-18T10:04:10.000Z",
					endedAt: "2026-04-18T10:05:00.000Z",
				}),
			],
			turnTraceIndex: {
				trn_1: makeTrace({
					assistant: { thinking: "First pass", text: "", lastUpdatedAt: null },
				}),
				trn_2: makeTrace({
					assistant: { thinking: "Second pass", text: "", lastUpdatedAt: null },
				}),
			},
			inputs: [
				makeInput({
					id: "inp_1",
					sequence: 1,
					bodyMarkdown: "Prompt one",
					receivedAt: "2026-04-18T10:01:00.000Z",
					consumedAt: "2026-04-18T10:01:05.000Z",
				}),
				makeInput({
					id: "inp_2",
					sequence: 2,
					bodyMarkdown: "Second turn fallback input",
					receivedAt: "2026-04-18T10:04:05.000Z",
					consumedAt: null,
				}),
			],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const entries = extractChronicleReasoningDetailEntries(projection);
		expect(entries).toHaveLength(2);
		expect(entries[1]?.triggeringInput).toMatchObject({
			inputId: "inp_2",
			bodyMarkdown: "Second turn fallback input",
			receivedAt: "2026-04-18T10:04:05.000Z",
			consumedAt: "2026-04-18T10:04:05.000Z",
		});
	});

	it("extracts reasoning detail entries with meta, input, and live state", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_done", createdAt: "2026-04-18T10:02:00.000Z" }),
				makeTurnRecord({
					id: "trn_live",
					status: "in_progress",
					outcome: "in_progress",
					createdAt: "2026-04-18T10:03:00.000Z",
				}),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_done",
					startedAt: "2026-04-18T10:01:10.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
					modelProfileId: "claude-sonnet-4",
				}),
				makeDurableTurnRecord({
					id: "trn_live",
					status: "running",
					startedAt: "2026-04-18T10:02:10.000Z",
					endedAt: null,
				}),
			],
			turnTraceIndex: {
				trn_done: makeTrace({
					assistant: { thinking: "Audit the repo", text: "", lastUpdatedAt: null },
					usage: {
						input: 1200,
						output: 340,
						cacheRead: 12,
						cacheWrite: 0,
						totalTokens: 1552,
					},
				}),
			},
			inputs: [
				makeInput({
					id: "inp_done",
					bodyMarkdown: "Done input",
					receivedAt: "2026-04-18T10:01:00.000Z",
					consumedAt: "2026-04-18T10:01:05.000Z",
				}),
				makeInput({
					id: "inp_live",
					sequence: 2,
					bodyMarkdown: "Live input",
					receivedAt: "2026-04-18T10:02:00.000Z",
					consumedAt: "2026-04-18T10:02:05.000Z",
				}),
			],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: makeActiveTurn({
				turnRecordId: "trn_live",
				startedAt: "2026-04-18T10:02:10.000Z",
				assistant: { thinking: "Still working", text: "", lastUpdatedAt: null },
				traceItems: [{ kind: "thinking", text: "Still working" }],
			}),
		});

		const entries = extractChronicleReasoningDetailEntries(projection);
		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			turnRecordId: "trn_done",
			isLive: false,
			modelProfileId: null,
			triggeringInput: { inputId: "inp_done", bodyMarkdown: "Done input" },
		});
		expect(entries[0]?.usage).toMatchObject({ input: 1200, output: 340, cacheRead: 12 });
		expect(entries[1]).toMatchObject({
			turnRecordId: "trn_live",
			isLive: true,
			stateLabel: "Reasoning",
			triggeringInput: { inputId: "inp_live", bodyMarkdown: "Live input" },
		});
	});

	it("attaches Pi input and operational facts to reasoning detail entries", () => {
		const projection = buildProjection({
			turnRecords: [makeTurnRecord({ id: "trn_done", turnId: "implement" })],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_done",
					turnId: "implement",
					startedAt: "2026-04-18T10:01:10.000Z",
					endedAt: "2026-04-18T10:02:40.000Z",
				}),
			],
			turnTraceIndex: {
				trn_done: makeTrace({
					assistant: { thinking: "Reason about the change", text: "", lastUpdatedAt: null },
					piInput: makePiInput(
						"Process context\n\nUser request: Please patch the bug",
						"2026-04-18T10:01:10.000Z",
					),
				}),
			},
			inputs: [
				makeInput({
					id: "inp_done",
					bodyMarkdown: "Please patch the bug",
					receivedAt: "2026-04-18T10:01:00.000Z",
					consumedAt: "2026-04-18T10:01:05.000Z",
				}),
			],
			runDetails: {
				systemPrompt: "System instructions",
				appendSystemPrompt: "Append instructions",
				availablePiToolNames: ["read", "bash", "edit"],
				turns: [
					{
						turnId: "implement",
						description: "Implement",
						activePiToolNames: ["read", "bash", "read"],
						outcomeActions: [{ name: "done", description: "Finish", parameters: [] }],
					},
				],
			},
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const [entry] = extractChronicleReasoningDetailEntries(projection);
		expect(entry?.piInput?.fullPrompt).toBe(
			"Process context\n\nUser request: Please patch the bug",
		);
		expect(entry?.piInput?.fullPrompt).not.toContain("System instructions");
		expect(entry?.piInput?.fullPrompt).not.toContain("Append instructions");
		expect(entry?.piInput?.userInput).toBe("Please patch the bug");
		expect(entry?.facts).toEqual({
			startedAt: "2026-04-18T10:01:10.000Z",
			endedAt: "2026-04-18T10:02:40.000Z",
			triggerSource: "user_action",
			runMode: "immediate",
			activeToolNames: ["read", "bash", "done"],
		});
	});

	it("uses scheduled action annotations when run-mode provenance is recorded", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_decision", turnType: "human", actionSource: "scheduled" }),
			],
			durableTurnRecords: [makeDurableTurnRecord({ id: "trn_decision", turnType: "human" })],
			turnTraceIndex: {
				trn_decision: makeTrace({
					assistant: { thinking: "Record the scheduled decision", text: "", lastUpdatedAt: null },
				}),
			},
			turnAnnotations: [
				makeTurnAnnotation({
					turnRecordId: "trn_decision",
					payload: { actionSource: "scheduled" },
				}),
			],
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const [entry] = extractChronicleReasoningDetailEntries(projection);
		expect(entry?.facts.runMode).toBe("scheduled");
		expect(entry?.facts.triggerSource).toBe("external_event");
	});

	it("carries action provenance when an annotation explicitly caused the LLM turn", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_decision", turnId: "poem_review", turnType: "human" }),
				makeTurnRecord({
					id: "trn_review",
					turnId: "review_poem_draft",
					createdAt: "2026-04-18T10:03:00.000Z",
					actionSource: "ui",
				}),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_decision",
					turnId: "poem_review",
					turnType: "human",
					startedAt: "2026-04-18T10:02:00.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
				makeDurableTurnRecord({
					id: "trn_review",
					turnId: "review_poem_draft",
					startedAt: "2026-04-18T10:03:00.000Z",
					endedAt: "2026-04-18T10:04:00.000Z",
				}),
			],
			turnTraceIndex: {
				trn_review: makeTrace({
					assistant: { thinking: "Review the poem", text: "", lastUpdatedAt: null },
				}),
			},
			turnAnnotations: [
				makeTurnAnnotation({
					turnRecordId: "trn_decision",
					payload: {
						actionSource: "ui",
						causedSelectedTurnId: "review_poem_draft",
						causedSelectedTurnType: "llm",
					},
				}),
			],
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const entry = extractChronicleReasoningDetailEntries(projection).find(
			(candidate) => candidate.turnRecordId === "trn_review",
		);
		expect(entry?.facts.triggerSource).toBe("user_action");
		expect(entry?.facts.runMode).toBe("immediate");
	});

	it("does not propagate action provenance without an explicit caused turn", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_decision", turnId: "poem_review", turnType: "human" }),
				makeTurnRecord({ id: "trn_review", turnId: "review_poem_draft" }),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_decision",
					turnId: "poem_review",
					turnType: "human",
					startedAt: "2026-04-18T10:02:00.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
				makeDurableTurnRecord({
					id: "trn_review",
					turnId: "review_poem_draft",
					startedAt: "2026-04-18T10:03:00.000Z",
					endedAt: "2026-04-18T10:04:00.000Z",
				}),
			],
			turnTraceIndex: {
				trn_review: makeTrace({
					assistant: { thinking: "Review the poem", text: "", lastUpdatedAt: null },
				}),
			},
			turnAnnotations: [
				makeTurnAnnotation({
					turnRecordId: "trn_decision",
					payload: { actionSource: "ui" },
				}),
			],
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const entry = extractChronicleReasoningDetailEntries(projection).find(
			(candidate) => candidate.turnRecordId === "trn_review",
		);
		expect(entry?.facts.triggerSource).toBe("unknown");
		expect(entry?.facts.runMode).toBe("unknown");
	});

	it("uses only the matching explicit target when multiple decisions precede an LLM turn", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({
					id: "trn_scheduled",
					turnId: "poem_review",
					turnType: "human",
					createdAt: "2026-04-18T10:02:00.000Z",
				}),
				makeTurnRecord({
					id: "trn_external",
					turnId: "await_external",
					turnType: "external",
					createdAt: "2026-04-18T10:02:30.000Z",
				}),
				makeTurnRecord({
					id: "trn_review",
					turnId: "review_poem_draft",
					createdAt: "2026-04-18T10:03:00.000Z",
					actionSource: "scheduled",
				}),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_scheduled",
					turnId: "poem_review",
					turnType: "human",
					startedAt: "2026-04-18T10:02:00.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
				makeDurableTurnRecord({
					id: "trn_external",
					turnId: "await_external",
					turnType: "external",
					startedAt: "2026-04-18T10:02:30.000Z",
					endedAt: "2026-04-18T10:02:30.000Z",
				}),
				makeDurableTurnRecord({
					id: "trn_review",
					turnId: "review_poem_draft",
					startedAt: "2026-04-18T10:03:00.000Z",
					endedAt: "2026-04-18T10:04:00.000Z",
				}),
			],
			turnTraceIndex: {
				trn_review: makeTrace({
					assistant: { thinking: "Review the poem", text: "", lastUpdatedAt: null },
				}),
			},
			turnAnnotations: [
				makeTurnAnnotation({
					turnRecordId: "trn_scheduled",
					payload: {
						actionSource: "scheduled",
						causedSelectedTurnId: "review_poem_draft",
						causedSelectedTurnType: "llm",
					},
					createdAt: "2026-04-18T10:02:00.000Z",
				}),
				makeTurnAnnotation({
					turnRecordId: "trn_external",
					payload: {
						actionSource: "external",
						causedSelectedTurnId: "unrelated_review_turn",
						causedSelectedTurnType: "llm",
					},
					createdAt: "2026-04-18T10:02:30.000Z",
				}),
			],
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const entry = extractChronicleReasoningDetailEntries(projection).find(
			(candidate) => candidate.turnRecordId === "trn_review",
		);
		expect(entry?.facts.triggerSource).toBe("external_event");
		expect(entry?.facts.runMode).toBe("scheduled");
	});

	it("does not carry explicit action provenance to later LLM records with the same turn id", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_decision", turnId: "poem_review", turnType: "human" }),
				makeTurnRecord({
					id: "trn_review_first",
					turnId: "review_poem_draft",
					createdAt: "2026-04-18T10:03:00.000Z",
					actionSource: "ui",
				}),
				makeTurnRecord({
					id: "trn_review_retry",
					turnId: "review_poem_draft",
					createdAt: "2026-04-18T10:05:00.000Z",
				}),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_decision",
					turnId: "poem_review",
					turnType: "human",
					startedAt: "2026-04-18T10:02:00.000Z",
					endedAt: "2026-04-18T10:02:00.000Z",
				}),
				makeDurableTurnRecord({
					id: "trn_review_first",
					turnId: "review_poem_draft",
					startedAt: "2026-04-18T10:03:00.000Z",
					endedAt: "2026-04-18T10:04:00.000Z",
				}),
				makeDurableTurnRecord({
					id: "trn_review_retry",
					turnId: "review_poem_draft",
					parentTurnRecordId: "trn_review_first",
					startedAt: "2026-04-18T10:05:00.000Z",
					endedAt: "2026-04-18T10:06:00.000Z",
				}),
			],
			turnTraceIndex: {
				trn_review_first: makeTrace({
					assistant: { thinking: "Review the poem", text: "", lastUpdatedAt: null },
				}),
				trn_review_retry: makeTrace({
					assistant: { thinking: "Review the poem again", text: "", lastUpdatedAt: null },
				}),
			},
			turnAnnotations: [
				makeTurnAnnotation({
					turnRecordId: "trn_decision",
					payload: {
						actionSource: "ui",
						causedSelectedTurnId: "review_poem_draft",
						causedSelectedTurnType: "llm",
					},
					createdAt: "2026-04-18T10:02:00.000Z",
				}),
			],
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const entries = extractChronicleReasoningDetailEntries(projection);
		expect(
			entries.find((candidate) => candidate.turnRecordId === "trn_review_first")?.facts
				.triggerSource,
		).toBe("user_action");
		expect(
			entries.find((candidate) => candidate.turnRecordId === "trn_review_retry")?.facts
				.triggerSource,
		).toBe("unknown");
	});

	it("creates reasoning detail entries for LLM turns with prompt data but no reasoning", () => {
		const projection = buildProjection({
			turnRecords: [makeTurnRecord({ id: "trn_prompt_only", turnId: "draft_poem" })],
			durableTurnRecords: [makeDurableTurnRecord({ id: "trn_prompt_only", turnId: "draft_poem" })],
			turnTraceIndex: {
				trn_prompt_only: makeTrace({
					piInput: makePiInput("Generated draft prompt containing operator request"),
				}),
			},
			initialUserInputText: "operator request",
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const [entry] = extractChronicleReasoningDetailEntries(projection);
		expect(entry?.turnRecordId).toBe("trn_prompt_only");
		expect(entry?.reasoningSection.items).toEqual([]);
		expect(entry?.reasoningSection.text).toBe("");
		expect(entry?.piInput?.userInput).toBe("operator request");
	});

	it.each([
		"completed",
		"in_progress",
	] as const)("opens reasoning details for a %s turn with questions but no trace", (status) => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_unrelated" }),
				makeTurnRecord({ id: "trn_question", status, outcome: status }),
			],
			turnTraceIndex: {},
			activeTurn:
				status === "in_progress"
					? makeActiveTurn({ turnRecordId: "trn_question", eventWindowTruncated: true })
					: null,
		});

		expect(extractChronicleReasoningDetailEntries(projection)).toHaveLength(
			status === "in_progress" ? 1 : 0,
		);
		const entries = extractChronicleReasoningDetailEntries(projection, [
			createTestQuestionRequest({
				turnRecordId: "trn_question",
				status: status === "in_progress" ? "open" : "answered",
			}),
		]);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			turnRecordId: "trn_question",
			isLive: status === "in_progress",
			reasoningSection: { text: "", items: [] },
		});
	});

	it("projects tool-only compact traces as accessible reasoning details", () => {
		const projection = buildProjection({
			turnRecords: [makeTurnRecord({ id: "trn_tools" })],
			turnTraceIndex: {},
			turnTracePreviewIndex: {
				trn_tools: makeTracePreview({
					turnRecordId: "trn_tools",
					toolCallCount: 2,
					traceItemCount: 3,
					hasReasoningDetails: true,
				}),
			},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const cluster = projection.timelineItems.find((item) => item.kind === "turn_cluster");
		const reasoningSection =
			cluster?.kind === "turn_cluster"
				? cluster.sections.find((section) => section.kind === "thinking_preview")
				: undefined;
		expect(reasoningSection).toMatchObject({
			kind: "thinking_preview",
			toolCallCount: 2,
			traceItemCount: 3,
		});
		expect(extractChronicleReasoningDetailEntries(projection)).toHaveLength(1);
	});

	it("preserves compact trace truncation for many short reasoning lines", () => {
		const projection = buildProjection({
			turnRecords: [makeTurnRecord({ id: "trn_truncated" })],
			turnTraceIndex: {},
			turnTracePreviewIndex: {
				trn_truncated: makeTracePreview({
					turnRecordId: "trn_truncated",
					thinkingPreview: "… line 18\nline 19\nline 20",
					thinkingPreviewTruncated: true,
					traceItemCount: 20,
					hasReasoningDetails: true,
				}),
			},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		const cluster = projection.timelineItems.find((item) => item.kind === "turn_cluster");
		const reasoningSection =
			cluster?.kind === "turn_cluster"
				? cluster.sections.find((section) => section.kind === "thinking_preview")
				: undefined;
		expect(reasoningSection).toMatchObject({
			kind: "thinking_preview",
			previewTruncated: true,
			traceItemCount: 20,
		});
	});

	it("derives Pi input for live reasoning detail entries from the active turn trace", () => {
		const activeTurn = makeActiveTurn({
			turnRecordId: "trn_live",
			turnId: "review_poem_draft",
			assistant: { thinking: "Live thought", text: "", lastUpdatedAt: null },
			traceItems: [{ kind: "thinking", text: "Live thought" }],
		});
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({
					id: "trn_live",
					turnId: "review_poem_draft",
					status: "in_progress",
					modelProfileId: "gpt-live",
				}),
			],
			durableTurnRecords: [
				makeDurableTurnRecord({
					id: "trn_live",
					turnId: "review_poem_draft",
					status: "running",
					endedAt: null,
				}),
			],
			turnTraceIndex: {
				trn_live: makeTrace({
					piInput: makePiInput("Live generated review prompt"),
				}),
			},
			initialUserInputText: "operator request",
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn,
		});

		const [entry] = extractChronicleReasoningDetailEntries(projection);
		expect(entry?.isLive).toBe(true);
		expect(entry?.piInput?.fullPrompt).toContain("Live generated review prompt");
		expect(entry?.piInput?.userInput).toBe("operator request");
	});

	it("prepends a prompt item when prompt data is supplied", () => {
		const projection = buildProjection({
			turnRecords: [makeTurnRecord()],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
			promptText: "Ship the requested change",
			promptCreatedAt: "2026-04-18T09:59:00.000Z",
		});

		expect(projection.promptItem).toMatchObject({
			kind: "prompt",
			text: "Ship the requested change",
		});
		expect(projection.timelineItems[0]).toMatchObject({
			kind: "prompt",
			text: "Ship the requested change",
		});
	});

	it("uses the requested user input for the displayed prompt when the Pi prompt includes generated context", () => {
		const projection = buildProjection({
			turnRecords: [makeTurnRecord()],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
			promptText: [
				"Process context for the turn.",
				"",
				"Operator request:",
				"Make the process info prompt display clearer.",
				"",
				"Return a concise implementation.",
			].join("\n"),
			initialUserInputText: "Make the process info prompt display clearer.",
			promptCreatedAt: "2026-04-18T09:59:00.000Z",
		});

		expect(projection.promptItem).toMatchObject({
			kind: "prompt",
			text: "Make the process info prompt display clearer.",
		});
		expect(projection.timelineItems[0]).toMatchObject({
			kind: "prompt",
			text: "Make the process info prompt display clearer.",
		});
	});

	it("does not synthesize a prompt item when prompt text is absent", () => {
		const projection = buildProjection({
			turnRecords: [],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
			promptText: null,
			promptCreatedAt: null,
		});

		expect(projection.promptItem).toBeNull();
		expect(projection.timelineItems).toEqual([]);
		expect(projection.initialAnchorId).toBeNull();
	});

	it("keeps bounded text context for the viewport to wrap into four lines", () => {
		const completed = makeTurnRecord({
			id: "trn_done",
			createdAt: "2026-04-18T10:00:00.000Z",
			output: "Shipped answer",
		});
		const active = makeTurnRecord({
			id: "trn_live",
			status: "in_progress",
			outcome: "in_progress",
			createdAt: "2026-04-18T10:03:00.000Z",
		});
		const thinkingTrace = ["line one", "line two", "line three", "line four", "line five"].join(
			"\n",
		);

		const projection = buildProjection({
			turnRecords: [completed, active],
			turnTraceIndex: {
				trn_done: makeTrace({
					assistant: {
						text: "Shipped answer",
						thinking: thinkingTrace,
						lastUpdatedAt: "2026-04-18T10:00:00.000Z",
					},
					traceItems: [{ kind: "thinking", text: thinkingTrace }],
				}),
			},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: makeActiveTurn({
				assistant: {
					text: "",
					thinking: thinkingTrace,
					lastUpdatedAt: "2026-04-18T10:03:10.000Z",
				},
				traceItems: [{ kind: "thinking", text: thinkingTrace }],
			}),
		});

		if (projection.timelineItems[0]?.kind !== "turn_cluster") {
			throw new Error("expected a turn cluster");
		}
		expect(projection.timelineItems[0].sections[0]).toMatchObject({
			kind: "thinking_preview",
			preview: thinkingTrace,
			previewTruncated: false,
		});
		expect(projection.liveTail?.copy).toBe(thinkingTrace);
	});

	it("collapses blank lines in the preview while preserving full reasoning whitespace", () => {
		const active = makeTurnRecord({
			id: "trn_live",
			status: "in_progress",
			outcome: "in_progress",
			createdAt: "2026-04-18T10:03:00.000Z",
		});
		const thinkingTrace = ". <br>\n\n";

		const projection = buildProjection({
			turnRecords: [active],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: makeActiveTurn({
				assistant: {
					text: "",
					thinking: thinkingTrace,
					lastUpdatedAt: "2026-04-18T10:03:10.000Z",
				},
				traceItems: [{ kind: "thinking", text: thinkingTrace }],
			}),
		});

		expect(projection.liveTail?.reasoningSection).toMatchObject({
			preview: ". <br>\n",
			previewTruncated: false,
		});
		if (projection.liveTail?.reasoningSection?.kind !== "thinking_preview") {
			throw new Error("expected a live reasoning section");
		}
		expect(projection.liveTail.reasoningSection.preview.split("\n")).toEqual([". <br>", ""]);
		expect(projection.liveTail.reasoningSection.text).toBe(thinkingTrace);
	});

	it("keeps a durable result visible when it matches the assistant's final text", () => {
		const projection = buildProjection({
			turnRecords: [
				makeTurnRecord({ id: "trn_done", turnResultMarkdown: "The garden notes are ready." }),
			],
			turnTraceIndex: {
				trn_done: makeTrace({
					assistant: { text: "The garden notes are ready.", thinking: "", lastUpdatedAt: null },
				}),
			},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});
		const turn = projection.timelineItems.find((item) => item.kind === "turn_cluster");
		expect(turn?.sections.filter((section) => section.kind === "turn_result")).toEqual([
			{ kind: "turn_result", markdown: "The garden notes are ready." },
		]);
	});

	it("omits the saved-result section when a ready leaf outcome already renders that turn", () => {
		const completed = makeTurnRecord({
			id: "trn_done",
			createdAt: "2026-04-18T10:00:00.000Z",
			output: "Shipped answer",
			turnResultMarkdown: "## Final\n\nShipped answer with context",
		});
		const projection = buildProjection({
			turnRecords: [completed],
			turnTraceIndex: {
				trn_done: makeTrace({
					assistant: {
						text: "Shipped answer",
						thinking: "Plan the response before answering.",
						lastUpdatedAt: "2026-04-18T10:00:00.000Z",
					},
					traceItems: [{ kind: "thinking", text: "Plan the response before answering." }],
				}),
			},
			inputs: [],
			leafOutcomeSnapshots: [
				makeSnapshot({
					id: "los_ready",
					turnRecordId: "trn_done",
					anchoredAt: "2026-04-18T10:00:01.000Z",
					rendererId: "test:leaf_outcome",
					status: "ready",
					fallbackMarkdown: null,
				}),
			],
			definesLeafOutcome: true,
			activeTurn: null,
		});

		if (projection.timelineItems[0]?.kind !== "turn_cluster") {
			throw new Error("expected a turn cluster");
		}
		expect(projection.timelineItems[0].sections.map((section) => section.kind)).toEqual([
			"thinking_preview",
		]);
		if (projection.timelineItems[1]?.kind !== "leaf_outcome") {
			throw new Error("expected a leaf outcome");
		}
		expect(projection.timelineItems[1].status).toBe("ready");
	});

	it("keeps the saved-result section when leaf outcome capture failed", () => {
		const completed = makeTurnRecord({
			id: "trn_done",
			createdAt: "2026-04-18T10:00:00.000Z",
			output: "Shipped answer",
			turnResultMarkdown: "## Final\n\nShipped answer with context",
		});
		const projection = buildProjection({
			turnRecords: [completed],
			turnTraceIndex: {
				trn_done: makeTrace({
					assistant: {
						text: "Shipped answer",
						thinking: "Plan the response before answering.",
						lastUpdatedAt: "2026-04-18T10:00:00.000Z",
					},
					traceItems: [{ kind: "thinking", text: "Plan the response before answering." }],
				}),
			},
			inputs: [],
			leafOutcomeSnapshots: [
				makeSnapshot({
					id: "los_capture_error",
					turnRecordId: "trn_done",
					anchoredAt: "2026-04-18T10:00:01.000Z",
					status: "capture_error",
					warningCode: "capture_exception",
					warningMessage: "boom",
				}),
			],
			definesLeafOutcome: true,
			activeTurn: null,
		});

		if (projection.timelineItems[0]?.kind !== "turn_cluster") {
			throw new Error("expected a turn cluster");
		}
		expect(projection.timelineItems[0].sections.map((section) => section.kind)).toEqual([
			"thinking_preview",
			"turn_result",
		]);
	});

	it("projects leaf outcome snapshots after the matching completed turn and maps anchors back to the turn", () => {
		const completed = makeTurnRecord({
			id: "trn_done",
			createdAt: "2026-04-18T10:00:00.000Z",
			output: "Answer",
		});
		const projection = buildProjection({
			turnRecords: [completed],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [
				makeSnapshot({
					id: "los_ready",
					turnRecordId: "trn_done",
					anchoredAt: "2026-04-18T10:00:00.000Z",
					fallbackMarkdown: "## Snapshot",
				}),
			],
			definesLeafOutcome: true,
			activeTurn: null,
		});

		expect(projection.timelineItems.map((item) => item.kind)).toEqual([
			"turn_cluster",
			"leaf_outcome",
		]);
		expect(projection.initialAnchorId).toBe(
			projection.timelineItems[1] && "anchorId" in projection.timelineItems[1]
				? projection.timelineItems[1].anchorId
				: null,
		);
		if (projection.timelineItems[1]?.kind !== "leaf_outcome") {
			throw new Error("expected leaf outcome item");
		}
		expect(projection.timelineItems[1]).toMatchObject({
			snapshotId: "los_ready",
			turnRecordId: "trn_done",
			status: "ready",
		});
	});

	it("prefers the latest review-leaf snapshot for initial focus and anchor selection", () => {
		const draft = makeTurnRecord({
			id: "trn_draft",
			turnId: "draft_poem",
			displayTurn: "draft_poem",
			createdAt: "2026-04-18T10:00:00.000Z",
			output: "Drafted poem",
		});
		const review = makeTurnRecord({
			id: "trn_review",
			turnId: "review_poem_draft",
			displayTurn: "review_poem_draft",
			createdAt: "2026-04-18T10:02:00.000Z",
			output: "Review complete",
		});
		const projection = buildProjection({
			turnRecords: [draft, review],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [
				makeSnapshot({
					id: "los_draft",
					turnRecordId: "trn_draft",
					anchoredAt: "2026-04-18T10:01:00.000Z",
				}),
				makeSnapshot({
					id: "los_review",
					leafEntryId: "assistant-review",
					turnRecordId: "trn_review",
					anchoredAt: "2026-04-18T10:03:00.000Z",
				}),
			],
			definesLeafOutcome: true,
			activeTurn: null,
		});

		expect(projection.timelineItems.map((item) => item.kind)).toEqual([
			"turn_cluster",
			"leaf_outcome",
			"turn_cluster",
			"leaf_outcome",
		]);
		expect(projection.initialFocusedTurnId).toBe("trn_review");
		if (projection.timelineItems[3]?.kind !== "leaf_outcome") {
			throw new Error("expected review leaf outcome item");
		}
		expect(projection.initialAnchorId).toBe(projection.timelineItems[3].anchorId);
	});

	it("prefers the current running tool for the live tail and appends the placeholder when no turn is active", () => {
		const completed = makeTurnRecord({
			id: "trn_done",
			output: "Ship it",
			turnResultMarkdown: "",
		});
		const projectionWithLiveTool = buildProjection({
			turnRecords: [
				completed,
				makeTurnRecord({
					id: "trn_live",
					status: "in_progress",
					outcome: "in_progress",
				}),
			],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: true,
			activeTurn: makeActiveTurn({
				assistant: {
					text: "Current answer",
					thinking: "Current thinking",
					lastUpdatedAt: "2026-04-18T10:05:00.000Z",
				},
				toolCalls: [
					{
						toolCallId: "tool_live",
						toolName: "read",
						status: "running",
						startedAt: "2026-04-18T10:05:01.000Z",
						completedAt: null,
						arguments: { path: "README.md" },
						result: null,
						isError: false,
					},
				],
				traceItems: [
					{ kind: "thinking", text: "Current thinking" },
					{ kind: "tool_call", toolCallId: "tool_live" },
				],
			}),
		});
		expect(projectionWithLiveTool.liveTail).toMatchObject({
			state: "tool_running",
			copy: "Running Read…",
		});

		const projectionWithoutLiveTurn = buildProjection({
			turnRecords: [completed],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: true,
			activeTurn: null,
		});
		expect(projectionWithoutLiveTurn.liveTail).toBeNull();
		expect(projectionWithoutLiveTurn.timelineItems.at(-1)).toEqual(
			expect.objectContaining({ kind: "leaf_outcome_placeholder" }),
		);
		expect(projectionWithoutLiveTurn.initialAnchorId).toBe(
			projectionWithoutLiveTurn.turnRailItems[0]?.anchorId,
		);
	});

	it("preserves reasoning text when a live turn becomes a committed tree-backed turn", () => {
		const reasoningText =
			"Reasoning visible while streaming. This full sentence must still exist after commit.";
		const liveProjection = buildProjection({
			turnRecords: [
				makeTurnRecord({
					id: "trn_live",
					status: "in_progress",
					outcome: "in_progress",
					createdAt: "2026-04-18T10:03:00.000Z",
				}),
			],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: makeActiveTurn({
				turnRecordId: "trn_live",
				assistant: {
					text: "",
					thinking: reasoningText,
					lastUpdatedAt: "2026-04-18T10:03:05.000Z",
				},
				traceItems: [{ kind: "thinking", text: reasoningText }],
			}),
		});
		expect(liveProjection.liveTail?.reasoningSection?.text).toBe(reasoningText);

		const committedTraceIndex = {
			trn_live: makeTrace({
				assistant: {
					text: "Committed answer",
					thinking: reasoningText,
					lastUpdatedAt: "2026-04-18T10:03:10.000Z",
				},
				traceItems: [{ kind: "thinking", text: reasoningText }],
			}),
		};
		const committedProjection = buildProjection({
			turnRecords: [
				makeTurnRecord({
					id: "trn_live",
					createdAt: "2026-04-18T10:03:10.000Z",
					output: "Committed answer",
				}),
			],
			turnTraceIndex: committedTraceIndex,
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});
		const cluster = committedProjection.timelineItems[0];
		if (cluster?.kind !== "turn_cluster") {
			throw new Error("expected a committed turn cluster");
		}
		const reasoningSection = cluster.sections[0];
		if (reasoningSection?.kind !== "thinking_preview") {
			throw new Error("expected a committed reasoning section");
		}
		expect(reasoningSection.text).toBe(reasoningText);
	});

	it("adds a dedicated terminal rail item for completed and aborted processes", () => {
		const completed = makeTurnRecord({
			id: "trn_done",
			output: "Conversation complete",
		});
		const completedProjection = buildProjection({
			turnRecords: [completed],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
			lifecycleStatus: "completed",
		});
		const abortedProjection = buildProjection({
			turnRecords: [completed],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
			lifecycleStatus: "aborted",
		});

		expect(completedProjection.terminalRailItem).toEqual({
			terminalStatus: "completed",
			anchorId: "chronicle-terminal-completed",
			title: "Completed",
		});
		expect(completedProjection.initialAnchorId).toBe("chronicle-terminal-completed");
		expect(abortedProjection.terminalRailItem).toEqual({
			terminalStatus: "aborted",
			anchorId: "chronicle-terminal-aborted",
			title: "Aborted",
		});
		expect(abortedProjection.initialAnchorId).toBe("chronicle-terminal-aborted");
	});

	it("omits the placeholder when the process does not define a leaf outcome", () => {
		const completed = makeTurnRecord({
			id: "trn_done",
			output: "Conversation complete",
		});
		const projection = buildProjection({
			turnRecords: [completed],
			turnTraceIndex: {},
			inputs: [],
			leafOutcomeSnapshots: [],
			definesLeafOutcome: false,
			activeTurn: null,
		});

		expect(projection.timelineItems.map((item) => item.kind)).toEqual(["turn_cluster"]);
		expect(projection.liveTail).toBeNull();
		expect(projection.initialAnchorId).toBe(projection.turnRailItems[0]?.anchorId);
	});
});
