import type {
	InstanceTreeEdgeSummary,
	InstanceTreeNodeSummary,
} from "@leitwerk-dev/protocol/http-contracts";
import { describe, expect, it } from "vitest";
import { layoutInstanceTree } from "./instance-tree-layout.js";

const node = (
	id: string,
	parentId: string | null,
	timestamp = id,
	pathType: InstanceTreeNodeSummary["pathType"] = parentId ? "primary" : "root_branch",
): InstanceTreeNodeSummary => ({
	id,
	parentId,
	label: id,
	pathType,
	resultState: "succeeded",
	timestamp,
});

const edge = (
	sourceNodeId: string,
	targetNodeId: string | null,
	kind: "context" | "product" | "decision" = "context",
	actionLabel: string | null = null,
): InstanceTreeEdgeSummary => ({
	id: `${sourceNodeId}->${targetNodeId}`,
	sourceNodeId,
	targetNodeId,
	hasContext: kind === "context",
	productLabels: kind === "product" ? ["Plan"] : [],
	actionLabel,
	endState: targetNodeId ? null : "not_applied",
});

describe("layoutInstanceTree", () => {
	it("keeps linear continuation in one row and puts a non-root branch on a new row", () => {
		const layout = layoutInstanceTree(
			[
				node("branch", "root", "3", "leaf_branch"),
				node("continue", "root", "2"),
				node("root", null, "1"),
			],
			"branch",
			[edge("root", "continue"), edge("root", "branch")],
		);
		const root = layout?.nodes.find((item) => item.id === "root");
		const continuation = layout?.nodes.find((item) => item.id === "continue");
		const branch = layout?.nodes.find((item) => item.id === "branch");
		expect(continuation?.lane).toBe(root?.lane);
		expect(branch?.lane).not.toBe(root?.lane);
		expect(branch).toMatchObject({ contextOrigin: "previous", startsLane: true });
		expect(root?.childCount).toBe(2);
		expect(layout?.edges.map((item) => item.id)).toEqual(["root->continue", "root->branch"]);
		expect(branch?.isCurrent).toBe(true);
	});

	it("positions a parent first when timestamps tie and ids sort the child first", () => {
		const layout = layoutInstanceTree(
			[node("a-child", "z-parent", "1"), node("z-parent", null, "1")],
			null,
			[edge("z-parent", "a-child")],
		);
		expect(layout?.nodes.find((item) => item.id === "a-child")).toMatchObject({
			lane: 0,
			startsLane: false,
		});
	});

	it("routes decisions to the next context and renders missing targets as dead ends", () => {
		const layout = layoutInstanceTree(
			[node("review", null, "1"), node("draft", null, "3")],
			"draft",
			[
				edge("review", "draft", "decision", "Accept review"),
				edge("review", null, "decision", "Dismiss review"),
			],
		);
		expect(layout?.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					targetNodeId: "draft",
					actionLabel: "Accept review",
					endState: null,
				}),
				expect.objectContaining({
					targetNodeId: null,
					actionLabel: "Dismiss review",
					endState: "not_applied",
				}),
			]),
		);
	});

	it("starts root turns on separate fresh rows and preserves product edges", () => {
		const layout = layoutInstanceTree(
			[node("plan", null, "1"), node("implement", null, "2")],
			"implement",
			[edge("plan", "implement", "product")],
		);
		const [plan, implement] = layout?.nodes ?? [];
		expect(plan?.contextOrigin).toBe("fresh");
		expect(implement?.contextOrigin).toBe("fresh");
		expect(implement?.lane).not.toBe(plan?.lane);
		expect(implement?.x).toBe(plan?.x);
		expect(layout?.edges[0]).toMatchObject({ productLabels: ["Plan"] });
	});
});
