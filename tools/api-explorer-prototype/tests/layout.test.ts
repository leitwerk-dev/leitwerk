import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { describe, expect, it } from "vitest";
import { layoutGraph } from "../src/layout-graph";
import fixture from "./fixtures/package-layout.json";

const elk = new ELK();
const packages = fixture.packages.map((id) => ({ id, width: 252, height: 167 }));
const edges = fixture.dependencies.map(([from, to]) => ({
	id: `${from}->${to}`,
	source: packages[from].id,
	target: packages[to].id,
}));

function overlaps(nodes: ElkNode[]) {
	return nodes.flatMap((a, i) =>
		nodes
			.slice(i + 1)
			.filter(
				(b) =>
					a.x! < b.x! + b.width! &&
					a.x! + a.width! > b.x! &&
					a.y! < b.y! + b.height! &&
					a.y! + a.height! > b.y!,
			)
			.map((b) => [a.id, b.id]),
	);
}

describe("ELK card layout", () => {
	it("places real consumers to the left of dependencies, without overlapping any of the 31 packages", async () => {
		const result = await elk.layout(layoutGraph(packages, edges, true));
		expect(result.children).toHaveLength(31);
		expect(result.edges).toHaveLength(fixture.dependencies.length);
		expect(overlaps(result.children!)).toEqual([]);
		const byId = new Map(result.children!.map((node) => [node.id, node]));
		for (const edge of edges)
			expect(byId.get(edge.target)!.x!, edge.id).toBeGreaterThan(byId.get(edge.source)!.x! + 252);
		const domain = byId.get("@leitwerk-dev/domain")!;
		const forgejo = byId.get("@leitwerk-dev/forgejo-repo-change")!;
		expect(domain.x).toBe(Math.max(...result.children!.map((node) => node.x!)));
		expect(forgejo.x).toBe(Math.min(...result.children!.map((node) => node.x!)));
		for (const node of result.children!) {
			expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
			expect(node).toMatchObject({ width: 252, height: 167 });
		}
	});
	it("keeps real cycles and their downstream dependencies usable", async () => {
		const nodes = ["a", "b", "c", "foundation"].map((id) => ({ id, width: 252, height: 200 }));
		const connections = [
			["a", "b"],
			["b", "c"],
			["c", "a"],
			["c", "foundation"],
		].map(([source, target]) => ({ id: `${source}->${target}`, source, target }));
		const result = await elk.layout(layoutGraph(nodes, connections, true));
		expect(overlaps(result.children!)).toEqual([]);
		expect(result.children!.find((node) => node.id === "foundation")!.x!).toBeGreaterThan(
			result.children!.find((node) => node.id === "c")!.x!,
		);
	});
	it("uses expanded note sizes and includes disconnected packages without overlaps", async () => {
		const nodes = packages.map((node, i) => ({ ...node, height: i % 3 ? 167 : 420 }));
		nodes.push({ id: "isolated-package", width: 252, height: 480 });
		const result = await elk.layout(layoutGraph(nodes, edges, true));
		expect(result.children).toHaveLength(nodes.length);
		expect(overlaps(result.children!)).toEqual([]);
		for (const node of result.children!)
			expect(node).toMatchObject(nodes.find((original) => original.id === node.id)!);
		const repeated = await elk.layout(layoutGraph(nodes, edges, true));
		const positions = (graph: ElkNode) => graph.children!.map(({ id, x, y }) => ({ id, x, y }));
		expect(positions(repeated)).toEqual(positions(result));
	});
	it("keeps focused APIs and their members separated in a directed layout", async () => {
		const nodes = packages.slice(0, 7);
		const connections = nodes.slice(1).map((node) => ({
			id: `api->${node.id}`,
			source: nodes[0].id,
			target: node.id,
		}));
		const result = await elk.layout(layoutGraph(nodes, connections, false));
		expect(overlaps(result.children!)).toEqual([]);
		const root = result.children![0];
		for (const child of result.children!.slice(1)) expect(child.x!).toBeGreaterThan(root.x!);
	});
});
