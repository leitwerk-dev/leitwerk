import { describe, expect, it } from "vitest";
import { emptyParamsCodec } from "./codecs.js";
import type { TurnDefinition } from "./define-process.js";
import { automaticTurn, defineProcess, humanTurn, llmTurn } from "./define-process.js";
import { buildProcessFlowView, collapseRoutingTurns } from "./process-flow-view.js";
import { toProcessGraphView } from "./process-graph.js";

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

	it("carries turn types and descriptions onto nodes and falls back to the turn id", () => {
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

	it("omits operator-decision turns and keeps only work nodes and end states", () => {
		const process = defineFlow({
			entry: "draft",
			happyPath: ["draft", "decision", "commit"],
			turns: {
				draft: llm({ description: "Draft", outcomes: { saved: { to: "decision" } } }),
				decision: human({
					description: "Operator decision",
					actions: { approve: { to: "commit" }, revise: { to: "draft" } },
				}),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const view = buildProcessFlowView(toProcessGraphView(process));

		expect(view.nodes.some((node) => node.turnId === "decision")).toBe(false);
		expect(view.nodes.every((node) => node.turnType !== "human")).toBe(true);
		expect(view.spine).toEqual(["draft", "commit"]);
	});
});

describe("collapseRoutingTurns", () => {
	it("merges an operator decision into its work anchor and re-emits actions from it", () => {
		const process = defineFlow({
			entry: "draft",
			happyPath: ["draft", "implement"],
			turns: {
				draft: llm({ description: "Draft", outcomes: { saved: { to: "decision" } } }),
				decision: human({
					description: "Operator decision",
					actions: { approve: { to: "implement" }, revise: { to: "draft" } },
				}),
				implement: llm({ description: "Implement", turnEnd: { complete: true } }),
			},
		});

		const collapsed = collapseRoutingTurns(toProcessGraphView(process));

		expect([...collapsed.turns.keys()].sort()).toEqual(["draft", "implement"]);
		// `decision` anchors to `draft` (its only work predecessor). The edge into the
		// decision becomes a self-loop on `draft`, and the decision's actions are
		// re-emitted from `draft`.
		const draftTransitions = collapsed.turns.get("draft")?.transitions ?? [];
		expect(draftTransitions).toContainEqual({ nextTurnId: "implement", outcome: "approve" });
		expect(draftTransitions).toContainEqual({ nextTurnId: "draft", outcome: "revise" });
	});

	it("remaps entry turns that are operator decisions to their anchor", () => {
		const process = defineFlow({
			entry: "decision",
			turns: {
				decision: human({
					description: "Operator decision",
					actions: { begin: { to: "work" } },
				}),
				work: llm({ description: "Work", turnEnd: { complete: true } }),
			},
		});

		const collapsed = collapseRoutingTurns(toProcessGraphView(process));

		// The decision has no work predecessor, so it falls back to the first declared
		// work turn (`work`), which is also its entry remap target.
		expect([...collapsed.entryTurnIds]).toEqual(["work"]);
	});

	it("resolves terminal transitions declared on an operator decision onto its anchor", () => {
		const process = defineFlow({
			entry: "work",
			turns: {
				work: llm({ description: "Work", outcomes: { saved: { to: "decision" } } }),
				decision: human({
					description: "Operator decision",
					actions: { finish: { complete: true }, bail: { lifecycleStatus: "aborted" } },
				}),
			},
		});

		const collapsed = collapseRoutingTurns(toProcessGraphView(process));

		const workTransitions = collapsed.turns.get("work")?.transitions ?? [];
		expect(workTransitions).toContainEqual({ lifecycleStatus: "completed", outcome: "finish" });
		expect(workTransitions).toContainEqual({ lifecycleStatus: "aborted", outcome: "bail" });
	});

	it("drops operator-decision turns from the happy path", () => {
		const process = defineFlow({
			entry: "draft",
			happyPath: ["draft", "decision", "commit"],
			turns: {
				draft: llm({ description: "Draft", outcomes: { saved: { to: "decision" } } }),
				decision: human({
					description: "Operator decision",
					actions: { approve: { to: "commit" } },
				}),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const collapsed = collapseRoutingTurns(toProcessGraphView(process));

		expect(collapsed.happyPath).toEqual(["draft", "commit"]);
	});

	it("never invents a work→work edge that no single declared transition connects", () => {
		// review reaches its decision via no_issues; the decision can simplify, but
		// `simplify` belongs to the implementation decision anchored on `implement`,
		// not to `review`. No `review -> simplify` edge may appear.
		const process = defineFlow({
			entry: "implement",
			happyPath: ["implement", "commit"],
			turns: {
				implement: llm({ description: "Implement", outcomes: { done: { to: "impl_decision" } } }),
				impl_decision: human({
					description: "Implementation decision",
					actions: {
						merge: { to: "commit" },
						revise: { to: "implement" },
						simplify: { to: "simplify" },
						review: { to: "review" },
					},
				}),
				review: llm({
					description: "Review",
					outcomes: { no_issues: { to: "impl_decision" } },
				}),
				simplify: llm({ description: "Simplify", outcomes: { done: { to: "impl_decision" } } }),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const collapsed = collapseRoutingTurns(toProcessGraphView(process));

		// `impl_decision` anchors to `implement` (happy-path work predecessor).
		const reviewTransitions = collapsed.turns.get("review")?.transitions ?? [];
		expect(reviewTransitions.some((t) => t.nextTurnId === "simplify")).toBe(false);
		// review's only declared edge resolves to the anchor and is a self-loop on review? No:
		// review -> impl_decision resolves to review -> implement.
		expect(reviewTransitions).toContainEqual({ nextTurnId: "implement", outcome: "no_issues" });

		// The `simplify` action lives only on the anchor that owns it.
		const implementTransitions = collapsed.turns.get("implement")?.transitions ?? [];
		expect(implementTransitions).toContainEqual({ nextTurnId: "simplify", outcome: "simplify" });
	});

	it("leaves graphs without routing turns unchanged", () => {
		const process = defineFlow({
			entry: "draft",
			turns: {
				draft: llm({ description: "Draft", outcomes: { saved: { to: "commit" } } }),
				commit: llm({ description: "Commit", turnEnd: { complete: true } }),
			},
		});

		const graph = toProcessGraphView(process);
		expect(collapseRoutingTurns(graph)).toBe(graph);
	});
});
