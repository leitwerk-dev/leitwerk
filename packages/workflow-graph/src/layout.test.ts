import type { ProcessFlowNode, ProcessFlowView } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { layoutWorkflow, shortestSuccessfulPath, type WorkflowEdge } from "./index.js";

const edge = (
	from: string,
	to: string | null,
	kind: ProcessFlowView["edges"][number]["kind"] = "branch",
	label: string | null = `${from} to ${to}`,
): ProcessFlowView["edges"][number] => ({
	from,
	to,
	kind,
	label,
	lifecycleStatus: to === null ? "completed" : null,
});

function fixture(): ProcessFlowView {
	const node = (
		turnId: string,
		turnType: ProcessFlowNode["turnType"] = "llm",
		repeated = false,
	): ProcessFlowNode => ({
		turnId,
		description: turnId,
		turnType,
		role: "branch",
		spineIndex: null,
		anchorTurnId: null,
		isEntry: turnId === "gather",
		...(repeated ? { repetition: "sequential" } : {}),
	});
	return {
		processId: "release",
		entryTurnIds: ["gather"],
		spine: ["gather", "assess", "review", "publish"],
		nodes: [
			node("gather", "automatic"),
			node("assess", "llm", true),
			node("review", "human"),
			node("publish", "automatic"),
		],
		edges: [
			edge("gather", "assess"),
			edge("assess", "review"),
			edge("assess", "publish"),
			edge("review", "publish"),
			edge("review", "assess", "loopback"),
			edge("publish", null, "terminal"),
		],
		endStates: [
			{ lifecycleStatus: "completed", synthetic: false },
			{ lifecycleStatus: "aborted", synthetic: true },
		],
	};
}

function repositoryFlow(): ProcessFlowView {
	const base = fixture();
	return {
		...base,
		entryTurnIds: ["plan"],
		nodes: ["plan", "review", "implement", "simplify", "apply", "commit", "publish"].map((id) => ({
			...base.nodes[0],
			turnId: id,
			description: id,
			turnType: id === "review" ? "human" : "llm",
			isEntry: id === "plan",
		})),
		edges: [
			["plan", "review"],
			["plan", "implement"],
			["review", "implement"],
			["review", "plan"],
			["implement", "simplify"],
			["implement", "commit"],
			["simplify", "apply"],
			["apply", "commit"],
			["commit", "publish"],
			["publish", null],
		].map(([from, to]) => edge(from as string, to, to === null ? "terminal" : "branch", null)),
	};
}

function expectSeparate(first: WorkflowEdge, second: WorkflowEdge) {
	for (let i = 1; i < first.points.length; i++) {
		const a = first.points[i - 1],
			b = first.points[i];
		for (let j = 1; j < second.points.length; j++) {
			const c = second.points[j - 1],
				d = second.points[j];
			expect(
				Math.max(a.x, b.x) < Math.min(c.x, d.x) ||
					Math.max(c.x, d.x) < Math.min(a.x, b.x) ||
					Math.max(a.y, b.y) < Math.min(c.y, d.y) ||
					Math.max(c.y, d.y) < Math.min(a.y, b.y),
				`${first.from} → ${first.to} and ${second.from} → ${second.to} must not overlap or cross`,
			).toBe(true);
		}
	}
}

describe("workflow layout", () => {
	it.each([
		false,
		true,
	])("separates incoming revision from outgoing review, reversed=%s", (reverse) => {
		const flow = repositoryFlow();
		if (reverse) flow.edges.reverse();
		const graph = layoutWorkflow(flow);
		const review = graph.edges.find(
			(edge) => edge.from === "turn:plan" && edge.to === "turn:review",
		);
		const revision = graph.edges.find(
			(edge) => edge.from === "turn:review" && edge.to === "turn:plan",
		);
		if (!review || !revision) throw new Error("Missing plan review routes");
		expect(revision.kind).toBe("loopback");
		expect(review.points[0]).not.toEqual(revision.points.at(-1));
		expect(Math.abs(review.points[0].x - (revision.points.at(-1)?.x ?? 0))).toBeGreaterThanOrEqual(
			24,
		);
		expectSeparate(review, revision);
	});
	it("rejoins a forward detour from below without marking it as rework", () => {
		const graph = layoutWorkflow(repositoryFlow());
		const commit = graph.nodes.find((node) => node.id === "turn:commit");
		const apply = graph.nodes.find((node) => node.id === "turn:apply");
		const rejoin = graph.edges.find((edge) => edge.from === apply?.id && edge.to === commit?.id);
		if (!commit || !apply || !rejoin) throw new Error("Missing simplification rejoin");
		expect(apply.column).toBeGreaterThan(commit.column);
		expect(rejoin.kind).toBe("branch");
		expect(rejoin.sourceSide).toBe("top");
		expect(rejoin.targetSide).toBe("bottom");
		expect(rejoin.points.at(-1)).toEqual({
			x: commit.x + commit.width / 2,
			y: commit.y + commit.height,
		});
		expect(rejoin.points.every((point) => point.y >= commit.y + commit.height)).toBe(true);
		const middleY = (apply.y + commit.y + commit.height) / 2;
		expect(rejoin.points.slice(1, -1).every((point) => point.y === middleY)).toBe(true);
		expect(middleY - (commit.y + commit.height)).toBeGreaterThanOrEqual(40);
	});
	it("places the actual shortest successful path on one horizontal line", () => {
		const flow = fixture();
		expect(shortestSuccessfulPath(flow)).toEqual(["gather", "assess", "publish"]);
		const graph = layoutWorkflow(flow);
		const main = graph.mainPath.map((id) => graph.nodes.find((node) => node.id === id));
		expect(new Set(main.map((node) => node && node.y + node.height / 2)).size).toBe(1);
		for (let index = 1; index < main.length; index++) {
			const edge = graph.edges.find(
				(edge) => edge.from === main[index - 1]?.id && edge.to === main[index]?.id,
			);
			expect(edge?.points).toHaveLength(2);
			expect(edge?.points[0].y).toBe(edge?.points[1].y);
		}
	});
	it("keeps collection internal and every declared route visible", () => {
		const flow = fixture(),
			graph = layoutWorkflow(flow);
		expect(graph.edges).toHaveLength(flow.edges.length);
		expect(graph.nodes.filter((node) => node.repeat)).toHaveLength(1);
		expect(graph.nodes.some((node) => node.title === "Collect results")).toBe(false);
		const repeated = graph.nodes.find((node) => node.repeat);
		const incoming = graph.edges.find(
			(edge) => edge.to === repeated?.id && edge.kind !== "loopback",
		);
		const outgoing = graph.edges.find(
			(edge) =>
				edge.from === repeated?.id && edge.targetSide === "left" && edge.sourceSide === "right",
		);
		expect(incoming?.points.at(-1)).toEqual({
			x: repeated?.x,
			y: (repeated?.y ?? 0) + (repeated?.repeat?.axis ?? 0),
		});
		expect(outgoing?.points[0]).toEqual({
			x: (repeated?.x ?? 0) + (repeated?.width ?? 0),
			y: (repeated?.y ?? 0) + (repeated?.repeat?.axis ?? 0),
		});
		expect(graph.nodes.find((node) => node.kind === "aborted")?.synthetic).toBe(true);
		expect(graph.edges.some((edge) => edge.to === "end:aborted")).toBe(false);
	});
	it("separates multiple maps, long titles, branches, and self-return routes", () => {
		const flow = fixture();
		const original = flow.nodes[1];
		flow.nodes.push(
			{
				...original,
				turnId: "second-map",
				description:
					"Review all the operational consequences and evidence for this proposed component change",
				repetition: "sequential",
			},
			{ ...original, turnId: "another-branch", repetition: undefined },
		);
		flow.edges.push(
			edge("gather", "second-map", "branch", "Research"),
			edge("gather", "another-branch", "branch", "Investigate"),
			edge("second-map", "publish", "branch", "Ready"),
			edge("publish", "publish", "loopback", "Repeat publication"),
		);
		const graph = layoutWorkflow(flow);
		expect(graph.nodes.filter((node) => node.repeat)).toHaveLength(2);
		for (const [index, a] of graph.nodes.entries())
			for (const b of graph.nodes.slice(index + 1)) {
				expect(
					a.x >= b.x + b.width ||
						b.x >= a.x + a.width ||
						a.y >= b.y + b.height ||
						b.y >= a.y + a.height,
				).toBe(true);
			}
		expect(graph.edges.find((edge) => edge.from === edge.to)?.points.length).toBeGreaterThan(3);
		for (const edge of graph.edges)
			for (let i = 1; i < edge.points.length; i++) {
				const a = edge.points[i - 1],
					b = edge.points[i];
				expect(a.x === b.x || a.y === b.y).toBe(true);
				for (const node of graph.nodes) {
					const enters =
						a.y === b.y
							? a.y > node.y &&
								a.y < node.y + node.height &&
								Math.max(a.x, b.x) > node.x &&
								Math.min(a.x, b.x) < node.x + node.width
							: a.x > node.x &&
								a.x < node.x + node.width &&
								Math.max(a.y, b.y) > node.y &&
								Math.min(a.y, b.y) < node.y + node.height;
					expect(enters, `${edge.id} crosses ${node.id}`).toBe(false);
				}
			}
	});
	it("preserves the central path with multiple outcomes to the same destination", () => {
		const flow = fixture();
		flow.edges.push({ ...flow.edges[2], label: "Also clear" });
		const graph = layoutWorkflow(flow),
			edges = graph.edges.filter(
				(edge) => edge.from === "turn:assess" && edge.to === "turn:publish",
			);
		expect(edges).toHaveLength(2);
		expect(edges[0].points).toHaveLength(2);
		expect(edges[0].points[0]).not.toEqual(edges[1].points[0]);
		expect(edges[0].points.at(-1)).not.toEqual(edges[1].points.at(-1));
	});
	it.each([
		false,
		true,
	])("keeps revision and cancellation routes separate with reversed declarations=%s", (reverse) => {
		const flow = fixture();
		flow.entryTurnIds = ["assess"];
		flow.spine = ["assess", "review", "publish"];
		flow.nodes = flow.nodes
			.filter((node) => node.turnId !== "gather")
			.map((node) => ({ ...node, repetition: undefined, isEntry: node.turnId === "assess" }));
		flow.edges = flow.edges.filter(
			(edge) => edge.from !== "gather" && !(edge.from === "assess" && edge.to === "publish"),
		);
		flow.edges.push({
			from: "review",
			to: null,
			kind: "terminal",
			lifecycleStatus: "aborted",
			label: "Cancel",
		});
		if (reverse) flow.edges.reverse();
		const graph = layoutWorkflow(flow);
		const revision = graph.edges.find(
			(edge) => edge.from === "turn:review" && edge.to === "turn:assess",
		);
		const cancel = graph.edges.find((edge) => edge.to === "end:aborted");
		if (!revision || !cancel) throw new Error("Missing operator decision routes");
		expect(revision.points[0].x).toBeLessThan(cancel.points[0].x);
		expectSeparate(revision, cancel);
		const approval = graph.edges.find(
			(edge) => edge.from === "turn:review" && edge.to === "turn:publish",
		);
		expect(approval?.points).toHaveLength(2);
		expect(approval?.points[0].y).toBe(approval?.points[1].y);
	});
	it("handles empty definitions and cycles without claiming completion", () => {
		const flow = fixture();
		flow.edges = flow.edges.filter((edge) => edge.lifecycleStatus !== "completed");
		expect(shortestSuccessfulPath(flow)).toEqual(["gather"]);
		expect(layoutWorkflow({ ...flow, nodes: [], edges: [], endStates: [] }).nodes).toEqual([]);
	});
});
