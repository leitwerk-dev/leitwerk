import type { ProcessFlowView } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { computeFlowLayout, edgeDisplayLabel, turnTypeDescription } from "./flow-layout.js";

function view(edges: ProcessFlowView["edges"]): ProcessFlowView {
	return {
		processId: "p",
		entryTurnIds: ["a"],
		spine: ["a", "b"],
		nodes: [
			{
				turnId: "a",
				description: "A",
				turnType: "llm",
				role: "spine",
				spineIndex: 0,
				anchorTurnId: null,
				isEntry: true,
			},
			{
				turnId: "b",
				description: "B",
				turnType: "llm",
				role: "spine",
				spineIndex: 1,
				anchorTurnId: null,
				isEntry: false,
			},
		],
		edges,
		endStates: [{ lifecycleStatus: "aborted", synthetic: true }],
	};
}

describe("turnTypeDescription", () => {
	it("returns a distinct operator-facing explanation for each turn type", () => {
		const types = ["llm", "human", "external", "automatic"] as const;
		const descriptions = types.map((type) => turnTypeDescription(type));
		for (const description of descriptions) {
			expect(description.length).toBeGreaterThan(0);
		}
		expect(new Set(descriptions).size).toBe(types.length);
	});
});

describe("edgeDisplayLabel", () => {
	it("shows the single label as-is", () => {
		expect(edgeDisplayLabel(["approve"])).toBe("approve");
	});

	it("shows a self-describing count when several labels share an edge", () => {
		expect(edgeDisplayLabel(["no_issues", "accept_review", "dismiss_review"])).toBe(
			"3 transitions",
		);
	});

	it("renders nothing for an unlabeled edge", () => {
		expect(edgeDisplayLabel([])).toBe("");
	});
});

describe("computeFlowLayout parallel-edge merging", () => {
	it("merges parallel transitions between the same boxes into one edge with all labels", () => {
		const layout = computeFlowLayout(
			view([
				{ from: "b", to: "a", lifecycleStatus: null, kind: "loopback", label: "no_issues" },
				{ from: "b", to: "a", lifecycleStatus: null, kind: "loopback", label: "accept_review" },
				{ from: "b", to: "a", lifecycleStatus: null, kind: "loopback", label: "dismiss_review" },
			]),
		);

		const merged = layout.edges.filter((edge) => edge.from === "b" && edge.to === "a");
		expect(merged).toHaveLength(1);
		expect(merged[0].labels).toEqual(["no_issues", "accept_review", "dismiss_review"]);
		expect(edgeDisplayLabel(merged[0].labels)).toBe("3 transitions");
	});

	it("keeps edges of different kinds between the same boxes separate", () => {
		const layout = computeFlowLayout(
			view([
				{ from: "a", to: "b", lifecycleStatus: null, kind: "forward", label: "approve" },
				{ from: "a", to: "b", lifecycleStatus: null, kind: "branch", label: "audit" },
			]),
		);

		const edges = layout.edges.filter((edge) => edge.from === "a" && edge.to === "b");
		expect(edges).toHaveLength(2);
		expect(edges.map((edge) => edge.kind).sort()).toEqual(["branch", "forward"]);
	});

	it("deduplicates identical labels on a merged edge", () => {
		const layout = computeFlowLayout(
			view([
				{ from: "b", to: "a", lifecycleStatus: null, kind: "loopback", label: "redo" },
				{ from: "b", to: "a", lifecycleStatus: null, kind: "loopback", label: "redo" },
			]),
		);

		const merged = layout.edges.filter((edge) => edge.from === "b" && edge.to === "a");
		expect(merged).toHaveLength(1);
		expect(merged[0].labels).toEqual(["redo"]);
	});
});
