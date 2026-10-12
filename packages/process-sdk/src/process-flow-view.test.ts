import { describe, expect, it } from "vitest";
import { emptyParamsCodec } from "./codecs.js";
import type { TurnDefinition } from "./define-process.js";
import { automaticTurn, defineProcess, humanTurn, llmTurn } from "./define-process.js";
import { buildProcessFlowView } from "./process-flow-view.js";
import { serializeProcessGraph, toProcessGraphView } from "./process-graph.js";

const stateCodec = {
	parse(value: unknown): Record<string, unknown> {
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	},
	serialize(value: Record<string, unknown>): unknown {
		return value;
	},
};

function llm(input: {
	description: string;
	outcomes?: Record<
		string,
		{ to?: string; complete?: boolean; lifecycleStatus?: "completed" | "aborted" }
	>;
	turnEnd?: { to?: string; complete?: boolean; lifecycleStatus?: "completed" | "aborted" };
}): TurnDefinition<Record<string, never>, Record<string, unknown>> {
	const base = {
		availableTools: [] as const,
		description: input.description,
		branchType: "primary" as const,
		context: "fresh" as const,
		prompt: async () => "prompt",
	};
	if (input.turnEnd) {
		return llmTurn({
			...base,
			turnEnd: { outcome: "done", params: {}, ...input.turnEnd },
		});
	}
	const outcomes = Object.fromEntries(
		Object.entries(input.outcomes ?? {}).map(([id, route]) => [
			id,
			{ description: id, parameters: {}, ...route },
		]),
	);
	return llmTurn({ ...base, outcomes });
}

function human(input: {
	description: string;
	actions: Record<
		string,
		{ to?: string; complete?: boolean; lifecycleStatus?: "completed" | "aborted" }
	>;
}): TurnDefinition<Record<string, never>, Record<string, unknown>> {
	const actions = Object.fromEntries(
		Object.entries(input.actions).map(([id, route]) => [
			id,
			{ label: id, acceptanceState: "neutral" as const, ...route },
		]),
	);
	return humanTurn({ description: input.description, actions });
}

function defineFlow(input: {
	id?: string;
	entry: string;
	alternateEntries?: readonly string[];
	happyPath?: readonly string[];
	turns: Record<string, TurnDefinition<Record<string, never>, Record<string, unknown>>>;
}) {
	return defineProcess({
		id: input.id ?? "test_process",
		displayName: "Test Process",
		entry: input.entry,
		...(input.alternateEntries ? { alternateEntries: input.alternateEntries } : {}),
		...(input.happyPath ? { happyPath: input.happyPath } : {}),
		paramsCodec: emptyParamsCodec,
		stateCodec,
		initialState: () => ({}),
		turns: input.turns,
	});
}

describe("buildProcessFlowView", () => {
	it("uses the declared happy path as the spine and hangs other turns off it", () => {
		const process = defineFlow({
			entry: "draft",
			happyPath: ["draft", "review", "implement", "commit"],
			turns: {
				draft: llm({ description: "Draft plan", outcomes: { saved: { to: "review" } } }),
				review: llm({
					description: "Review plan",
					outcomes: { approve: { to: "implement" }, revise: { to: "draft" } },
				}),
				implement: llm({
					description: "Implement",
					outcomes: { done: { to: "commit" }, audit: { to: "audit_step" } },
				}),
				audit_step: llm({ description: "Audit", outcomes: { back: { to: "implement" } } }),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

		expect(view.spine).toEqual(["draft", "review", "implement", "commit"]);
		const spineNodes = view.nodes.filter((node) => node.role === "spine").map((n) => n.turnId);
		expect(spineNodes).toEqual(["draft", "review", "implement", "commit"]);
		const audit = view.nodes.find((node) => node.turnId === "audit_step");
		expect(audit?.role).toBe("branch");
		expect(audit?.anchorTurnId).toBe("implement");
	});

	it("classifies forward, loopback, branch, and terminal edges", () => {
		const process = defineFlow({
			entry: "draft",
			happyPath: ["draft", "review", "commit"],
			turns: {
				draft: llm({ description: "Draft", outcomes: { saved: { to: "review" } } }),
				review: llm({
					description: "Review",
					outcomes: { approve: { to: "commit" }, revise: { to: "draft" }, audit: { to: "audit" } },
				}),
				audit: llm({ description: "Audit", outcomes: { back: { to: "review" } } }),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

		const edge = (from: string, to: string | null) =>
			view.edges.find((candidate) => candidate.from === from && candidate.to === to);

		expect(edge("draft", "review")?.kind).toBe("forward");
		expect(edge("review", "commit")?.kind).toBe("forward");
		expect(edge("review", "draft")?.kind).toBe("loopback");
		expect(edge("review", "audit")?.kind).toBe("branch");
		const terminal = view.edges.find((candidate) => candidate.kind === "terminal");
		expect(terminal?.from).toBe("commit");
		expect(terminal?.lifecycleStatus).toBe("completed");
	});

	it("derives edge labels from outcome and trigger metadata", () => {
		const process = defineFlow({
			entry: "draft",
			happyPath: ["draft", "commit"],
			turns: {
				draft: llm({ description: "Draft", outcomes: { plan_saved: { to: "commit" } } }),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

		const labelled = view.edges.find((edge) => edge.from === "draft" && edge.to === "commit");
		expect(labelled?.label).toBe("Plan Saved");
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
				review: human({ description: "Review", actions: { approve: { complete: true } } }),
			},
		});
		const view = buildProcessFlowView(toProcessGraphView(process));
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

	it("always reports an aborted end state, synthesized when no transition targets it", () => {
		const process = defineFlow({
			entry: "draft",
			happyPath: ["draft", "commit"],
			turns: {
				draft: llm({ description: "Draft", outcomes: { saved: { to: "commit" } } }),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

		const aborted = view.endStates.find((state) => state.lifecycleStatus === "aborted");
		expect(aborted).toEqual({ lifecycleStatus: "aborted", synthetic: true });
		const completed = view.endStates.find((state) => state.lifecycleStatus === "completed");
		expect(completed).toEqual({ lifecycleStatus: "completed", synthetic: false });
	});

	it("marks an aborted end state as non-synthetic when a transition targets it", () => {
		const process = defineFlow({
			entry: "draft",
			happyPath: ["draft", "commit"],
			turns: {
				draft: llm({
					description: "Draft",
					outcomes: { saved: { to: "commit" }, bail: { lifecycleStatus: "aborted" } },
				}),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

		const aborted = view.endStates.find((state) => state.lifecycleStatus === "aborted");
		expect(aborted).toEqual({ lifecycleStatus: "aborted", synthetic: false });
	});

	it("falls back to a derived spine when no happy path is declared", () => {
		const process = defineFlow({
			entry: "draft",
			turns: {
				draft: llm({ description: "Draft", outcomes: { saved: { to: "review" } } }),
				review: llm({
					description: "Review",
					outcomes: { approve: { to: "commit" }, revise: { to: "draft" } },
				}),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

		// Shortest forward path from entry to a turn that can complete.
		expect(view.spine).toEqual(["draft", "review", "commit"]);
	});

	it("derives a single-node spine when no completing path exists", () => {
		const process = defineFlow({
			entry: "draft",
			turns: {
				draft: llm({ description: "Draft", outcomes: { loop: { to: "draft" } } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

		expect(view.spine).toEqual(["draft"]);
	});

	it("carries the automatic turn type and description onto its node", () => {
		const process = defineFlow({
			entry: "draft",
			happyPath: ["draft", "merge"],
			turns: {
				draft: llm({ description: "Draft", outcomes: { saved: { to: "merge" } } }),
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
	});

	it("marks primary and alternate entry turns while preserving the primary spine", () => {
		const process = defineFlow({
			entry: "draft",
			alternateEntries: ["import"],
			happyPath: ["draft", "commit"],
			turns: {
				draft: llm({ description: "Draft", outcomes: { saved: { to: "commit" } } }),
				import: llm({ description: "Import", outcomes: { imported: { to: "commit" } } }),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

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
		const process = defineFlow({
			entry: "a",
			happyPath: ["a", "b", "c"],
			turns: {
				a: llm({ description: "A", outcomes: { next: { to: "b" }, side: { to: "shared" } } }),
				b: llm({ description: "B", outcomes: { next: { to: "c" }, side: { to: "shared" } } }),
				shared: llm({ description: "Shared", outcomes: { back: { to: "b" } } }),
				c: llm({ description: "C", turnEnd: { complete: true } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

		// "a" reaches "shared" directly and is the earliest spine node, so it anchors there.
		expect(view.nodes.find((node) => node.turnId === "shared")?.anchorTurnId).toBe("a");
	});

	it("keeps a visible operator node when a process has only operator turns", () => {
		const process = defineFlow({
			entry: "decision",
			turns: {
				decision: human({
					description: "Operator decision",
					actions: { finish: { complete: true } },
				}),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

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

	it("preserves operator decisions and their actual routes", () => {
		const process = defineFlow({
			entry: "draft",
			turns: {
				draft: llm({ description: "Draft", outcomes: { done: { to: "decision" } } }),
				decision: human({
					description: "Review",
					actions: { approve: { to: "publish" }, revise: { to: "draft" } },
				}),
				publish: llm({ description: "Publish", turnEnd: { complete: true } }),
			},
		});
		const view = buildProcessFlowView(toProcessGraphView(process));
		expect(view.spine).toEqual(["draft", "decision", "publish"]);
		expect(view.nodes.find((node) => node.turnId === "decision")?.turnType).toBe("human");
		expect(view.edges.map((edge) => [edge.from, edge.to])).toEqual([
			["draft", "decision"],
			["decision", "publish"],
			["decision", "draft"],
			["publish", null],
		]);
	});

	it("uses the shortest successful path even when the authored happy path is longer", () => {
		const process = defineFlow({
			entry: "start",
			happyPath: ["start", "review", "publish"],
			turns: {
				start: llm({
					description: "Start",
					outcomes: {
						review: { to: "review" },
						ready: { to: "publish" },
						cancel: { lifecycleStatus: "aborted" },
					},
				}),
				review: human({ description: "Review", actions: { approve: { to: "publish" } } }),
				publish: llm({ description: "Publish", turnEnd: { complete: true } }),
			},
		});
		expect(buildProcessFlowView(toProcessGraphView(process)).spine).toEqual(["start", "publish"]);
	});

	it("retains declared self-return routes", () => {
		const process = defineFlow({
			entry: "work",
			turns: {
				work: llm({
					description: "Work",
					outcomes: { again: { to: "work" }, done: { complete: true } },
				}),
			},
		});
		expect(buildProcessFlowView(toProcessGraphView(process)).edges).toContainEqual({
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
						itemCodec: stateCodec,
						resultCodec: stateCodec,
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
