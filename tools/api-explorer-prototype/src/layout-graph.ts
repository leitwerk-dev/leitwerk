import type { ElkNode } from "elkjs/lib/elk-api.js";

/** @internal Layout operates on measured card bounds, independently of saved positions. */
export interface LayoutNode {
	id: string;
	width: number;
	height: number;
}
/** @internal */
export interface LayoutEdge {
	id: string;
	source: string;
	target: string;
}
/** @internal Consumers precede their dependencies; measured bounds keep cards apart. */
export function layoutGraph(nodes: LayoutNode[], edges: LayoutEdge[], overview: boolean): ElkNode {
	return {
		id: "root",
		layoutOptions: {
			"elk.algorithm": "layered",
			"elk.edgeRouting": "POLYLINE",
			"elk.separateConnectedComponents": overview ? "false" : "true",
			"elk.randomSeed": "1",
			"elk.direction": "RIGHT",
			"elk.spacing.nodeNode": "36",
			"elk.layered.spacing.nodeNodeBetweenLayers": "100",
			"elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
			...(overview
				? {
						"elk.layered.nodePlacement.strategy": "SIMPLE",
						"elk.layered.compaction.postCompaction.strategy": "LEFT_RIGHT_CONSTRAINT_LOCKING",
					}
				: {}),
		},
		children: nodes.map((node) => ({ ...node })),
		edges: edges.map((edge) => ({
			id: edge.id,
			sources: [edge.source],
			targets: [edge.target],
		})),
	};
}
