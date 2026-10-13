import type { ProcessTurnTransition, ProcessTurnType } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { emptyParamsCodec } from "./codecs.js";
import type { TurnDefinition } from "./define-process.js";
import { automaticTurn, defineProcess, humanTurn, llmTurn } from "./define-process.js";
import { buildProcessFlowView } from "./process-flow-view.js";
import {
	type ProcessGraphTurnView,
	serializeProcessGraph,
	toProcessGraphView,
} from "./process-graph.js";

function turn(
	description: string,
	transitions: ProcessTurnTransition[],
	turnType: ProcessTurnType = "llm",
): ProcessGraphTurnView {
	return { description, transitions, turnType };
}

function project(input: {
	entry: string;
	alternateEntries?: readonly string[];
	happyPath?: readonly string[];
	turns: Record<string, ProcessGraphTurnView>;
}) {
	return buildProcessFlowView({
		id: "test_process",
		primaryEntryTurnId: input.entry,
		entryTurnIds: new Set([input.entry, ...(input.alternateEntries ?? [])]),
		happyPath: input.happyPath ?? null,
		turns: new Map(Object.entries(input.turns)),
	});
}

function defineFlow(input: {
	entry: string;
	turns: Record<string, TurnDefinition<Record<string, never>, Record<string, never>>>;
}) {
	return defineProcess({
		id: "test_process",
		displayName: "Test Process",
		paramsCodec: emptyParamsCodec,
		stateCodec: emptyParamsCodec,
		initialState: () => ({}),
		...input,
	});
}

describe("buildProcessFlowView", () => {
	it("places the shortest successful path on the spine and hangs other turns off it", () => {
		const view = project({
			entry: "draft",
			happyPath: ["draft", "review", "implement", "commit"],
			turns: {
				draft: turn("Draft plan", [{ outcome: "saved", nextTurnId: "review" }]),
				review: turn("Review plan", [
					{ outcome: "approve", nextTurnId: "implement" },
					{ outcome: "revise", nextTurnId: "draft" },
				]),
				implement: turn("Implement", [
					{ outcome: "done", nextTurnId: "commit" },
					{ outcome: "audit", nextTurnId: "audit_step" },
				]),
				audit_step: turn("Audit", [{ outcome: "back", nextTurnId: "implement" }]),
				commit: turn("Commit", [{ outcome: "done", lifecycleStatus: "completed" }]),
			},
		});
		expect(view.spine).toEqual(["draft", "review", "implement", "commit"]);
		const spineNodes = view.nodes.filter((node) => node.role === "spine").map((n) => n.turnId);
		expect(spineNodes).toEqual(["draft", "review", "implement", "commit"]);
		const audit = view.nodes.find((node) => node.turnId === "audit_step");
		expect(audit?.role).toBe("branch");
		expect(audit?.anchorTurnId).toBe("implement");
	});

	it("derives the spine without a happy path and classifies all edge kinds", () => {
		const view = project({
			entry: "draft",
			turns: {
				draft: turn("Draft", [{ outcome: "plan_saved", nextTurnId: "review" }]),
				review: turn(
					"Review",
					[
						{ trigger: "approve", nextTurnId: "commit" },
						{ trigger: "revise", nextTurnId: "draft" },
						{ trigger: "audit", nextTurnId: "audit" },
					],
					"human",
				),
				audit: turn("Audit", [{ outcome: "back", nextTurnId: "review" }]),
				commit: turn("Commit", [{ outcome: "done", lifecycleStatus: "completed" }]),
			},
		});
		expect(view.spine).toEqual(["draft", "review", "commit"]);
		expect(view.nodes.find((node) => node.turnId === "review")?.turnType).toBe("human");
		expect(view.edges.map((edge) => [edge.from, edge.to])).toEqual([
			["draft", "review"],
			["review", "commit"],
			["review", "draft"],
			["review", "audit"],
			["audit", "review"],
			["commit", null],
		]);
		const edge = (from: string, to: string | null) =>
			view.edges.find((candidate) => candidate.from === from && candidate.to === to);
		expect(edge("draft", "review")?.kind).toBe("forward");
		expect(edge("draft", "review")?.label).toBe("Plan Saved");
		expect(edge("review", "commit")?.kind).toBe("forward");
		expect(edge("review", "commit")?.label).toBe("Approve");
		expect(edge("review", "draft")?.kind).toBe("loopback");
		expect(edge("review", "audit")?.kind).toBe("branch");
		const terminal = view.edges.find((candidate) => candidate.kind === "terminal");
		expect(terminal?.from).toBe("commit");
		expect(terminal?.lifecycleStatus).toBe("completed");
	});

	it("preserves branch conditions without evaluating state or changing route identities", () => {
		const process = defineFlow({
			entry: "draft",
			turns: {
				draft: llmTurn({
					description: "Draft",
					availableTools: [],
					branchType: "primary",
					context: "fresh",
					prompt: () => "Draft",
					outcomes: {
						plan_saved: {
							description: "Save plan",
							parameters: {},
							branches: {
								approval: {
									to: "review",
									label: "Approval required",
									description: "An operator must approve the saved plan.",
								},
								bypass: { complete: true },
							},
							choose: () => {
								throw new Error("Definition inspection must not choose a route");
							},
						},
					},
				}),
				review: humanTurn({
					description: "Review",
					actions: { approve: { label: "approve", acceptanceState: "neutral", to: "merge" } },
				}),
				merge: automaticTurn({
					description: "Merge",
					run: async () => ({ outcome: "done", params: {} }),
					outcomes: { done: { description: "done", parameters: {}, complete: true } },
				}),
			},
		});
		const view = buildProcessFlowView(toProcessGraphView(process));
		const merge = view.nodes.find((node) => node.turnId === "merge");
		expect(merge?.turnType).toBe("automatic");
		expect(merge?.description).toBe("Merge");
		expect(view.edges.filter((edge) => edge.from === "draft")).toMatchObject([
			{
				to: "review",
				label: "Plan Saved",
				condition: {
					label: "Approval required",
					description: "An operator must approve the saved plan.",
				},
			},
			{ lifecycleStatus: "completed", label: "Plan Saved", condition: { label: "Bypass" } },
		]);
		expect(
			serializeProcessGraph(new Map([[process.id, process]]), process.id).turnTransitions.draft,
		).toEqual([
			{ nextTurnId: "review", trigger: "approval", outcome: "plan_saved" },
			{ lifecycleStatus: "completed", trigger: "bypass", outcome: "plan_saved" },
		]);
	});

	it.each([false, true])("reports abort availability, explicit=%s", (explicit) => {
		const transitions: ProcessTurnTransition[] = [{ outcome: "saved", nextTurnId: "commit" }];
		if (explicit) transitions.push({ outcome: "bail", lifecycleStatus: "aborted" });
		const view = project({
			entry: "draft",
			turns: {
				draft: turn("Draft", transitions),
				commit: turn("Commit", [{ outcome: "done", lifecycleStatus: "completed" }]),
			},
		});
		expect(view.endStates).toEqual([
			{ lifecycleStatus: "aborted", synthetic: !explicit },
			{ lifecycleStatus: "completed", synthetic: false },
		]);
	});

	it("derives a single-node spine when no completing path exists", () => {
		const view = project({
			entry: "draft",
			turns: { draft: turn("Draft", [{ outcome: "loop", nextTurnId: "draft" }]) },
		});
		expect(view.spine).toEqual(["draft"]);
	});

	it("marks primary and alternate entry turns while preserving the primary spine", () => {
		const view = project({
			entry: "draft",
			alternateEntries: ["import"],
			turns: {
				draft: turn("Draft", [{ outcome: "saved", nextTurnId: "commit" }]),
				import: turn("Import", [{ outcome: "imported", nextTurnId: "commit" }]),
				commit: turn("Commit", [{ outcome: "done", lifecycleStatus: "completed" }]),
			},
		});
		expect(view.nodes.find((node) => node.turnId === "draft")).toMatchObject({
			isEntry: true,
			role: "spine",
		});
		expect(view.nodes.find((node) => node.turnId === "import")).toMatchObject({
			isEntry: true,
			role: "branch",
		});
		expect(view.nodes.find((node) => node.turnId === "commit")?.isEntry).toBe(false);
		expect(view.entryTurnIds).toEqual(["draft", "import"]);
		expect(view.spine).toEqual(["draft", "commit"]);
	});

	it("anchors a branch to the earliest spine step that launches it", () => {
		const view = project({
			entry: "a",
			turns: {
				a: turn("A", [
					{ outcome: "next", nextTurnId: "b" },
					{ outcome: "side", nextTurnId: "shared" },
				]),
				b: turn("B", [
					{ outcome: "next", nextTurnId: "c" },
					{ outcome: "side", nextTurnId: "shared" },
				]),
				shared: turn("Shared", [{ outcome: "back", nextTurnId: "b" }]),
				c: turn("C", [{ outcome: "done", lifecycleStatus: "completed" }]),
			},
		});
		expect(view.nodes.find((node) => node.turnId === "shared")?.anchorTurnId).toBe("a");
	});

	it("keeps a visible operator node when a process has only operator turns", () => {
		const view = project({
			entry: "decision",
			turns: {
				decision: turn(
					"Operator decision",
					[{ trigger: "finish", lifecycleStatus: "completed" }],
					"human",
				),
			},
		});
		expect(view.spine).toEqual(["decision"]);
		expect(view.nodes).toMatchObject([
			{
				turnId: "decision",
				turnType: "human",
				role: "spine",
				isEntry: true,
			},
		]);
		expect(view.edges).toContainEqual({
			from: "decision",
			to: null,
			lifecycleStatus: "completed",
			kind: "terminal",
			label: "Finish",
		});
	});

	it("uses the shortest successful path even when the authored happy path is longer", () => {
		const view = project({
			entry: "start",
			happyPath: ["start", "review", "publish"],
			turns: {
				start: turn("Start", [
					{ outcome: "review", nextTurnId: "review" },
					{ outcome: "ready", nextTurnId: "publish" },
					{ outcome: "cancel", lifecycleStatus: "aborted" },
				]),
				review: turn("Review", [{ trigger: "approve", nextTurnId: "publish" }], "human"),
				publish: turn("Publish", [{ outcome: "done", lifecycleStatus: "completed" }]),
			},
		});
		expect(view.spine).toEqual(["start", "publish"]);
	});

	it("retains declared self-return routes", () => {
		const view = project({
			entry: "work",
			turns: {
				work: turn("Work", [
					{ outcome: "again", nextTurnId: "work" },
					{ outcome: "done", lifecycleStatus: "completed" },
				]),
			},
		});
		expect(view.edges).toContainEqual({
			from: "work",
			to: "work",
			lifecycleStatus: null,
			kind: "loopback",
			label: "Again",
		});
	});

	it("projects mapped turns and static tools without evaluating runtime callbacks", () => {
		const process = defineFlow({
			entry: "assess",
			turns: {
				assess: llmTurn({
					description: "Assess each item",
					availableTools: ["read"],
					integrationTools: ["read_status"],
					askQuestions: true,
					resolveIntegrationTools: () => {
						throw new Error("Must not resolve runtime tools for a definition graph");
					},
					branchType: "primary",
					context: "fresh",
					prompt: () => "Assess",
					outcomes: { submit_finding: { description: "Yield one finding", parameters: {} } },
					forEach: {
						items: () => {
							throw new Error("Must not freeze items for a definition graph");
						},
						itemCodec: emptyParamsCodec,
						resultCodec: emptyParamsCodec,
						key: () => "item",
						yields: { submit_finding: () => ({}) },
						collect: ({ state }) => state,
						routing: { kind: "static", lifecycleStatus: "completed" },
					},
				}),
			},
		});
		const view = buildProcessFlowView(toProcessGraphView(process));
		expect(view.nodes).toHaveLength(1);
		expect(view.nodes[0]).toMatchObject({
			repetition: "sequential",
			hasDynamicTools: true,
			tools: [
				{ name: "read", category: "workspace" },
				{ name: "read_status", category: "integration" },
				{ name: "ask_questions", category: "question" },
				{ name: "submit_finding", category: "outcome", description: "Yield one finding" },
			],
		});
		expect(view.edges).toHaveLength(1);
		expect(view.edges[0].lifecycleStatus).toBe("completed");
		expect(JSON.parse(JSON.stringify(view))).toEqual(view);
	});
});
