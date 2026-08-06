import { describe, expect, it } from "vitest";
import type { ChronicleProjection } from "./chronicle-projection.js";
import {
	buildChronicleSelectableItems,
	CHRONICLE_ACTION_SECTION_ANCHOR_ID,
	moveChronicleAnchorByOffset,
	resolveChronicleRailAnchorIdFromActiveAnchor,
	resolveChronicleTurnRecordIdForAnchor,
} from "./chronicle-selectable-items.js";

const defaultTurnFacts = {
	startedAt: null,
	endedAt: null,
	triggerSource: "unknown",
	runMode: "unknown",
	activeToolNames: [],
} as const;

function createProjection(): Pick<
	ChronicleProjection,
	"promptItem" | "turnRailItems" | "terminalRailItem" | "timelineItems"
> {
	return {
		promptItem: {
			kind: "prompt",
			anchorId: "chronicle-prompt",
			createdAt: null,
			text: "Prompt",
			preview: "Prompt",
		},
		turnRailItems: [
			{
				turnRecordId: "trn_one",
				retryLineageRootTurnRecordId: "trn_one",
				turnId: "turn_one",
				title: "Turn One",
				turnLabel: "turn_one",
				status: "completed",
				createdAt: "2026-04-18T10:00:00.000Z",
				shape: "circle",
				presentation: "llm_turn",
				hierarchy: "primary",
				kindLabel: "LLM turn",
				anchorId: "chronicle-turn-trn_one",
			},
			{
				turnRecordId: "trn_two",
				turnId: "turn_two",
				title: "Turn Two",
				turnLabel: "turn_two",
				status: "completed",
				createdAt: "2026-04-18T10:01:00.000Z",
				shape: "pill",
				presentation: "operator_decision",
				hierarchy: "secondary",
				kindLabel: "Operator decision",
				anchorId: "chronicle-turn-trn_two",
			},
		],
		terminalRailItem: {
			terminalStatus: "aborted",
			anchorId: "chronicle-terminal-aborted",
			title: "Aborted",
		},
		timelineItems: [
			{
				kind: "prompt",
				anchorId: "chronicle-prompt",
				createdAt: null,
				text: "Prompt",
				preview: "Prompt",
			},
			{
				kind: "turn_cluster",
				chronologyAt: "2026-04-18T10:00:00.000Z",
				anchorId: "chronicle-turn-trn_one",
				turnRecordId: "trn_one",
				turnId: "turn_one",
				title: "Turn One",
				turnLabel: "turn_one",
				createdAt: "2026-04-18T10:00:00.000Z",
				preview: "Turn One",
				isOperatorDecision: false,
				turnPresentation: "llm_turn",
				turnKindLabel: "LLM turn",
				terminalStatus: null,
				sections: [],
				modelProfileId: null,
				usage: null,
				triggeringInput: null,
				piInput: null,
				facts: defaultTurnFacts,
			},
			{
				kind: "leaf_outcome",
				chronologyAt: "2026-04-18T10:00:30.000Z",
				anchorId: "chronicle-leaf-outcome-snp_1",
				instanceId: "agt_1",
				snapshotId: "snp_1",
				leafEntryId: "leaf_1",
				turnRecordId: "trn_one",
				title: "Result",
				ownerTurnTitle: "Turn One",
				rendererId: null,
				schemaVersion: null,
				props: {},
				fallbackMarkdown: null,
				status: "ready",
				warningCode: null,
				warningMessage: null,
				anchoredAt: "2026-04-18T10:00:30.000Z",
				createdAt: "2026-04-18T10:00:31.000Z",
				processLifecycleStatus: "waiting",
				processSelectedTurnId: "turn_two",
				processUpdatedAt: "2026-04-18T10:00:32.000Z",
			},
			{
				kind: "turn_cluster",
				chronologyAt: "2026-04-18T10:01:00.000Z",
				anchorId: "chronicle-turn-trn_two",
				turnRecordId: "trn_two",
				turnId: "turn_two",
				title: "Turn Two",
				turnLabel: "turn_two",
				createdAt: "2026-04-18T10:01:00.000Z",
				preview: "Turn Two",
				isOperatorDecision: true,
				turnPresentation: "operator_decision",
				turnKindLabel: "Operator decision",
				terminalStatus: null,
				sections: [],
				modelProfileId: null,
				usage: null,
				triggeringInput: null,
				piInput: null,
				facts: defaultTurnFacts,
			},
		],
	};
}

describe("chronicle selectable items", () => {
	it("builds one ordered list for prompt, turns, terminal, and action without leaf-outcome waypoints", () => {
		const projection = createProjection();
		const items = buildChronicleSelectableItems({
			projection,
			pendingRailItem: {
				label: "Operator decision",
				title: "Decide what happens next",
				tone: "operator_decision",
			},
		});

		expect(items.map((item) => item.anchorId)).toEqual([
			"chronicle-prompt",
			"chronicle-turn-trn_one",
			"chronicle-turn-trn_two",
			"chronicle-terminal-aborted",
			CHRONICLE_ACTION_SECTION_ANCHOR_ID,
		]);
		expect(items.some((item) => item.anchorId === "chronicle-leaf-outcome-snp_1")).toBe(false);
		expect(items.some((item) => item.kind === "leaf_outcome")).toBe(false);
	});

	it("collapses adjacent retry-lineage rail items for the same turn id", () => {
		const projection = createProjection();
		const items = buildChronicleSelectableItems({
			projection: {
				...projection,
				turnRailItems: [
					projection.turnRailItems[0],
					{
						turnRecordId: "trn_three",
						retryLineageRootTurnRecordId: "trn_one",
						turnId: "turn_one",
						title: "Turn One",
						turnLabel: "turn_one",
						status: "in_progress",
						createdAt: "2026-04-18T10:02:00.000Z",
						shape: "circle",
						presentation: "llm_turn",
						hierarchy: "primary",
						kindLabel: "LLM turn",
						anchorId: "chronicle-live-trn_three",
					},
				],
				terminalRailItem: null,
				timelineItems: [
					projection.timelineItems[0],
					projection.timelineItems[1],
					{
						kind: "live_tail",
						anchorId: "chronicle-live-trn_three",
						turnRecordId: "trn_three",
						turnId: "turn_one",
						title: "Turn One",
						turnLabel: "turn_one",
						pathLabel: "Current path",
						state: "waiting",
						stateLabel: "Waiting for activity",
						copy: "Waiting for more activity…",
						reasoningSection: null,
						toolCall: null,
						eventWindowTruncated: false,
						modelProfileId: null,
						triggeringInput: null,
						piInput: null,
						facts: defaultTurnFacts,
					},
				],
			},
			pendingRailItem: null,
		});

		expect(items.map((item) => item.anchorId)).not.toContain("chronicle-turn-trn_one");
		expect(items.map((item) => item.anchorId)).toContain("chronicle-live-trn_three");
	});

	it("labels automatic turns as automation instead of operator work", () => {
		const projection = createProjection();
		const items = buildChronicleSelectableItems({
			projection: {
				...projection,
				turnRailItems: [
					projection.turnRailItems[0],
					{
						turnRecordId: "trn_auto",
						turnId: "commit_and_merge",
						title: "Commit And Merge",
						turnLabel: "commit_and_merge",
						status: "completed",
						createdAt: "2026-04-18T10:01:00.000Z",
						shape: "circle",
						presentation: "automatic_turn",
						hierarchy: "primary",
						kindLabel: "Automation",
						anchorId: "chronicle-turn-trn_auto",
					},
				],
				timelineItems: [
					projection.timelineItems[0],
					projection.timelineItems[1],
					{
						kind: "turn_cluster",
						chronologyAt: "2026-04-18T10:01:00.000Z",
						anchorId: "chronicle-turn-trn_auto",
						turnRecordId: "trn_auto",
						turnId: "commit_and_merge",
						title: "Commit And Merge",
						turnLabel: "commit_and_merge",
						createdAt: "2026-04-18T10:01:00.000Z",
						preview: "Commit And Merge",
						isOperatorDecision: false,
						turnPresentation: "automatic_turn",
						turnKindLabel: "Automation",
						terminalStatus: null,
						sections: [],
						modelProfileId: null,
						usage: null,
						triggeringInput: null,
						piInput: null,
						facts: defaultTurnFacts,
					},
				],
				terminalRailItem: null,
			},
			pendingRailItem: null,
		});

		expect(items.find((item) => item.anchorId === "chronicle-turn-trn_auto")).toMatchObject({
			kind: "turn",
			tone: "automatic_turn",
			markerText: "Auto",
			label: "Automation",
		});
	});

	it("moves through the turn-level anchors, skipping leaf outcomes", () => {
		const projection = createProjection();
		const items = buildChronicleSelectableItems({
			projection: { ...projection, terminalRailItem: null },
			pendingRailItem: null,
		});

		expect(moveChronicleAnchorByOffset(items, "chronicle-turn-trn_one", 1)).toBe(
			"chronicle-turn-trn_two",
		);
		expect(moveChronicleAnchorByOffset(items, "chronicle-turn-trn_one", -1)).toBe(
			"chronicle-prompt",
		);
		expect(moveChronicleAnchorByOffset(items, null, -1)).toBe("chronicle-turn-trn_one");
	});

	it("maps a leaf-outcome viewport anchor to its parent turn rail item", () => {
		const projection = createProjection();
		const items = buildChronicleSelectableItems({
			projection,
			pendingRailItem: null,
		});

		expect(
			resolveChronicleRailAnchorIdFromActiveAnchor(
				projection,
				items,
				"chronicle-leaf-outcome-snp_1",
			),
		).toBe("chronicle-turn-trn_one");
	});

	it("keeps failed turns visible when adding a recovery rail item", () => {
		const projection = createProjection();
		const items = buildChronicleSelectableItems({
			projection,
			pendingRailItem: {
				label: "Current turn",
				title: "Implement needs recovery",
				tone: "error_recovery",
				relatedTurnRecordId: "trn_two",
			},
		});

		expect(items.some((item) => item.anchorId === "chronicle-turn-trn_two")).toBe(true);
		expect(items.at(-1)?.anchorId).toBe(CHRONICLE_ACTION_SECTION_ANCHOR_ID);
		expect(
			resolveChronicleRailAnchorIdFromActiveAnchor(projection, items, "chronicle-turn-trn_two"),
		).toBe("chronicle-turn-trn_two");
	});

	it("maps collapsed retry-lineage anchors to the latest visible rail item", () => {
		const projection = {
			...createProjection(),
			turnRailItems: [
				createProjection().turnRailItems[0],
				{
					turnRecordId: "trn_three",
					retryLineageRootTurnRecordId: "trn_one",
					turnId: "turn_one",
					title: "Turn One",
					turnLabel: "turn_one",
					status: "in_progress",
					createdAt: "2026-04-18T10:02:00.000Z",
					shape: "circle",
					presentation: "llm_turn",
					hierarchy: "primary",
					kindLabel: "LLM turn",
					anchorId: "chronicle-live-trn_three",
				},
			],
			terminalRailItem: null,
			timelineItems: [
				createProjection().timelineItems[0],
				createProjection().timelineItems[1],
				{
					kind: "live_tail",
					anchorId: "chronicle-live-trn_three",
					turnRecordId: "trn_three",
					turnId: "turn_one",
					title: "Turn One",
					turnLabel: "turn_one",
					pathLabel: "Current path",
					state: "waiting",
					stateLabel: "Waiting for activity",
					copy: "Waiting for more activity…",
					reasoningSection: null,
					toolCall: null,
					usage: null,
					eventWindowTruncated: false,
					modelProfileId: null,
					triggeringInput: null,
					piInput: null,
					facts: defaultTurnFacts,
				},
			],
		};
		const items = buildChronicleSelectableItems({
			projection,
			pendingRailItem: null,
		});

		expect(
			resolveChronicleRailAnchorIdFromActiveAnchor(projection, items, "chronicle-turn-trn_one"),
		).toBe("chronicle-live-trn_three");
	});

	it("resolves associated turn ids for turn and recovery action anchors and skips leaf outcomes", () => {
		const projection = createProjection();
		const items = buildChronicleSelectableItems({
			projection,
			pendingRailItem: {
				label: "Current turn",
				title: "Implement needs recovery",
				tone: "error_recovery",
				relatedTurnRecordId: "trn_two",
			},
		});

		expect(resolveChronicleTurnRecordIdForAnchor(items, "chronicle-turn-trn_one")).toBe("trn_one");
		// Leaf outcomes are not selectable rail items, so their anchor resolves to null here.
		// Scroll sync maps the leaf-outcome viewport anchor to its parent turn instead.
		expect(resolveChronicleTurnRecordIdForAnchor(items, "chronicle-leaf-outcome-snp_1")).toBeNull();
		expect(
			resolveChronicleRailAnchorIdFromActiveAnchor(
				projection,
				items,
				"chronicle-leaf-outcome-snp_1",
			),
		).toBe("chronicle-turn-trn_one");
		expect(resolveChronicleTurnRecordIdForAnchor(items, CHRONICLE_ACTION_SECTION_ANCHOR_ID)).toBe(
			"trn_two",
		);
		expect(items.some((item) => item.anchorId === "chronicle-turn-trn_two")).toBe(true);
	});

	it("keeps distinct cycles for the same turn id and numbers the latest failed turn separately", () => {
		const projection: Pick<
			ChronicleProjection,
			"promptItem" | "turnRailItems" | "terminalRailItem" | "timelineItems"
		> = {
			promptItem: createProjection().promptItem,
			turnRailItems: [
				{
					turnRecordId: "trn_plan_1",
					retryLineageRootTurnRecordId: "trn_plan_1",
					turnId: "generate_plan",
					title: "Generate Plan",
					turnLabel: "generate_plan",
					status: "completed",
					createdAt: "2026-04-18T10:00:00.000Z",
					shape: "circle",
					presentation: "llm_turn",
					hierarchy: "primary",
					kindLabel: "LLM turn",
					anchorId: "chronicle-turn-trn_plan_1",
				},
				{
					turnRecordId: "trn_plan_3",
					retryLineageRootTurnRecordId: "trn_plan_2",
					turnId: "generate_plan",
					title: "Generate Plan",
					turnLabel: "generate_plan",
					status: "completed",
					createdAt: "2026-04-18T10:03:00.000Z",
					shape: "circle",
					presentation: "llm_turn",
					hierarchy: "primary",
					kindLabel: "LLM turn",
					anchorId: "chronicle-turn-trn_plan_3",
				},
				{
					turnRecordId: "trn_decision_1",
					retryLineageRootTurnRecordId: "trn_decision_1",
					turnId: "plan_decision",
					title: "Request Revision",
					turnLabel: "plan_decision",
					status: "completed",
					createdAt: "2026-04-18T10:02:00.000Z",
					shape: "pill",
					presentation: "operator_decision",
					hierarchy: "secondary",
					kindLabel: "Operator decision",
					anchorId: "chronicle-turn-trn_decision_1",
				},
				{
					turnRecordId: "trn_implement_2",
					retryLineageRootTurnRecordId: "trn_implement_1",
					turnId: "implement",
					title: "Implement",
					turnLabel: "implement",
					status: "completed",
					createdAt: "2026-04-18T10:05:00.000Z",
					shape: "circle",
					presentation: "llm_turn",
					hierarchy: "primary",
					kindLabel: "LLM turn",
					anchorId: "chronicle-turn-trn_implement_2",
				},
				{
					turnRecordId: "trn_decision_2",
					retryLineageRootTurnRecordId: "trn_decision_2",
					turnId: "implementation_decision",
					title: "Request Revision",
					turnLabel: "implementation_decision",
					status: "completed",
					createdAt: "2026-04-18T10:06:00.000Z",
					shape: "pill",
					presentation: "operator_decision",
					hierarchy: "secondary",
					kindLabel: "Operator decision",
					anchorId: "chronicle-turn-trn_decision_2",
				},
				{
					turnRecordId: "trn_implement_3",
					retryLineageRootTurnRecordId: "trn_implement_3",
					turnId: "implement",
					title: "Implement",
					turnLabel: "implement",
					status: "completed",
					createdAt: "2026-04-18T10:07:00.000Z",
					shape: "square",
					presentation: "llm_turn",
					hierarchy: "primary",
					kindLabel: "LLM turn",
					anchorId: "chronicle-turn-trn_implement_3",
				},
			],
			terminalRailItem: null,
			timelineItems: [
				createProjection().timelineItems[0],
				{
					kind: "turn_cluster",
					chronologyAt: "2026-04-18T10:00:00.000Z",
					anchorId: "chronicle-turn-trn_plan_1",
					turnRecordId: "trn_plan_1",
					turnId: "generate_plan",
					title: "Generate Plan",
					turnLabel: "generate_plan",
					createdAt: "2026-04-18T10:00:00.000Z",
					preview: "Generate Plan",
					isOperatorDecision: false,
					turnPresentation: "llm_turn",
					turnKindLabel: "LLM turn",
					terminalStatus: null,
					sections: [],
					modelProfileId: null,
					usage: null,
					triggeringInput: null,
					piInput: null,
					facts: defaultTurnFacts,
				},
				{
					kind: "turn_cluster",
					chronologyAt: "2026-04-18T10:01:00.000Z",
					anchorId: "chronicle-turn-trn_plan_2",
					turnRecordId: "trn_plan_2",
					turnId: "generate_plan",
					title: "Generate Plan",
					turnLabel: "generate_plan",
					createdAt: "2026-04-18T10:01:00.000Z",
					preview: "Generate Plan",
					isOperatorDecision: false,
					turnPresentation: "llm_turn",
					turnKindLabel: "LLM turn",
					terminalStatus: null,
					sections: [],
					modelProfileId: null,
					usage: null,
					triggeringInput: null,
					piInput: null,
					facts: defaultTurnFacts,
				},
				{
					kind: "turn_cluster",
					chronologyAt: "2026-04-18T10:02:00.000Z",
					anchorId: "chronicle-turn-trn_decision_1",
					turnRecordId: "trn_decision_1",
					turnId: "plan_decision",
					title: "Request Revision",
					turnLabel: "plan_decision",
					createdAt: "2026-04-18T10:02:00.000Z",
					preview: "Request Revision",
					isOperatorDecision: true,
					turnPresentation: "operator_decision",
					turnKindLabel: "Operator decision",
					terminalStatus: null,
					sections: [],
					modelProfileId: null,
					usage: null,
					triggeringInput: null,
					piInput: null,
					facts: defaultTurnFacts,
				},
				{
					kind: "turn_cluster",
					chronologyAt: "2026-04-18T10:03:00.000Z",
					anchorId: "chronicle-turn-trn_plan_3",
					turnRecordId: "trn_plan_3",
					turnId: "generate_plan",
					title: "Generate Plan",
					turnLabel: "generate_plan",
					createdAt: "2026-04-18T10:03:00.000Z",
					preview: "Generate Plan",
					isOperatorDecision: false,
					turnPresentation: "llm_turn",
					turnKindLabel: "LLM turn",
					terminalStatus: null,
					sections: [],
					modelProfileId: null,
					usage: null,
					triggeringInput: null,
					piInput: null,
					facts: defaultTurnFacts,
				},
				{
					kind: "turn_cluster",
					chronologyAt: "2026-04-18T10:04:00.000Z",
					anchorId: "chronicle-turn-trn_implement_1",
					turnRecordId: "trn_implement_1",
					turnId: "implement",
					title: "Implement",
					turnLabel: "implement",
					createdAt: "2026-04-18T10:04:00.000Z",
					preview: "Implement",
					isOperatorDecision: false,
					turnPresentation: "llm_turn",
					turnKindLabel: "LLM turn",
					terminalStatus: null,
					sections: [],
					modelProfileId: null,
					usage: null,
					triggeringInput: null,
					piInput: null,
					facts: defaultTurnFacts,
				},
				{
					kind: "turn_cluster",
					chronologyAt: "2026-04-18T10:05:00.000Z",
					anchorId: "chronicle-turn-trn_implement_2",
					turnRecordId: "trn_implement_2",
					turnId: "implement",
					title: "Implement",
					turnLabel: "implement",
					createdAt: "2026-04-18T10:05:00.000Z",
					preview: "Implement",
					isOperatorDecision: false,
					turnPresentation: "llm_turn",
					turnKindLabel: "LLM turn",
					terminalStatus: null,
					sections: [],
					modelProfileId: null,
					usage: null,
					triggeringInput: null,
					piInput: null,
					facts: defaultTurnFacts,
				},
				{
					kind: "turn_cluster",
					chronologyAt: "2026-04-18T10:06:00.000Z",
					anchorId: "chronicle-turn-trn_decision_2",
					turnRecordId: "trn_decision_2",
					turnId: "implementation_decision",
					title: "Request Revision",
					turnLabel: "implementation_decision",
					createdAt: "2026-04-18T10:06:00.000Z",
					preview: "Request Revision",
					isOperatorDecision: true,
					turnPresentation: "operator_decision",
					turnKindLabel: "Operator decision",
					terminalStatus: null,
					sections: [],
					modelProfileId: null,
					usage: null,
					triggeringInput: null,
					piInput: null,
					facts: defaultTurnFacts,
				},
				{
					kind: "turn_cluster",
					chronologyAt: "2026-04-18T10:07:00.000Z",
					anchorId: "chronicle-turn-trn_implement_3",
					turnRecordId: "trn_implement_3",
					turnId: "implement",
					title: "Implement",
					turnLabel: "implement",
					createdAt: "2026-04-18T10:07:00.000Z",
					preview: "Implement",
					isOperatorDecision: false,
					turnPresentation: "llm_turn",
					turnKindLabel: "LLM turn",
					terminalStatus: null,
					sections: [],
					modelProfileId: null,
					usage: null,
					triggeringInput: null,
					piInput: null,
					facts: defaultTurnFacts,
				},
			],
		};
		const items = buildChronicleSelectableItems({
			projection,
			pendingRailItem: {
				label: "Current turn",
				title: "Implement change",
				tone: "error_recovery",
				relatedTurnRecordId: "trn_implement_3",
			},
		});

		expect(
			items
				.filter((item) => item.kind === "turn" && item.tone === "llm_turn")
				.map((item) => ({ turnRecordId: item.turnRecordId, markerText: item.markerText })),
		).toEqual([
			{ turnRecordId: "trn_plan_1", markerText: "1" },
			{ turnRecordId: "trn_plan_3", markerText: "2" },
			{ turnRecordId: "trn_implement_2", markerText: "3" },
			{ turnRecordId: "trn_implement_3", markerText: "4" },
		]);
		expect(items.at(-2)).toMatchObject({
			kind: "turn",
			turnRecordId: "trn_implement_3",
			title: "Implement",
			markerText: "4",
		});
		expect(items.at(-1)).toMatchObject({
			kind: "action",
			title: "Implement change",
			turnRecordId: "trn_implement_3",
		});
	});
});
