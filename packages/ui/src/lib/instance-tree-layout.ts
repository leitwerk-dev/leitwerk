import type {
	InstanceTreeEdgeSummary,
	InstanceTreeNodeSummary,
} from "@leitwerk-dev/protocol/http-contracts";

const NODE_WIDTH = 196;
const NODE_HEIGHT = 68;
const LANE_LABEL_WIDTH = 126;
export const INSTANCE_TREE_COLUMN_GAP = 160;
const LANE_GAP = 72;
const HORIZONTAL_MARGIN = 24;
const VERTICAL_MARGIN = 60;

export interface InstanceTreeLayoutNode extends InstanceTreeNodeSummary {
	x: number;
	y: number;
	width: number;
	height: number;
	lane: number;
	startsLane: boolean;
	contextOrigin: "fresh" | "previous" | null;
	childCount: number;
	isCurrent: boolean;
}

export interface InstanceTreeLayoutEdge extends InstanceTreeEdgeSummary {
	points: { x: number; y: number }[];
}

export interface InstanceTreeLayout {
	width: number;
	height: number;
	laneCount: number;
	nodes: InstanceTreeLayoutNode[];
	edges: InstanceTreeLayoutEdge[];
}

function edgePathPoints(
	edge: InstanceTreeLayoutEdge,
	source: InstanceTreeLayoutNode,
	target: InstanceTreeLayoutNode,
): { x: number; y: number }[] {
	if (edge.productLabels.length) {
		const start = { x: source.x + source.width / 2, y: source.y };
		const departureX = start.x + 24;
		const end = { x: target.x, y: target.y - target.height / 2 };
		const approachY = end.y - 24;
		return [
			start,
			{ x: departureX, y: start.y },
			{ x: departureX, y: approachY },
			{ x: end.x, y: approachY },
			end,
		];
	}
	const end = { x: target.x - target.width / 2, y: target.y };
	if (source.lane !== target.lane && target.x <= source.x) {
		const start = { x: source.x, y: source.y + source.height / 2 };
		const transitY = start.y + Math.max(24, (target.y - start.y) * 0.45);
		const turnX = end.x - 40;
		return [
			start,
			{ x: start.x, y: transitY },
			{ x: turnX, y: transitY },
			{ x: turnX, y: end.y },
			end,
		];
	}
	const start = { x: source.x + source.width / 2, y: source.y };
	if (source.lane === target.lane) return [start, end];
	const bendX = Math.min(end.x - 24, start.x + Math.max(24, (end.x - start.x) * 0.45));
	return [start, { x: bendX, y: start.y }, { x: bendX, y: end.y }, end];
}

export function layoutInstanceTree(
	nodes: readonly InstanceTreeNodeSummary[],
	currentLeafId: string | null,
	edgeSummaries: readonly InstanceTreeEdgeSummary[] = [],
): InstanceTreeLayout | null {
	if (!nodes.length) return null;
	const sorted = [...nodes].sort(
		(left, right) =>
			left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id),
	);
	const byId = new Map(sorted.map((node) => [node.id, node]));
	const childrenByParent = new Map<string, InstanceTreeNodeSummary[]>();
	for (const node of sorted) {
		if (!node.parentId || !byId.has(node.parentId)) continue;
		const children = childrenByParent.get(node.parentId) ?? [];
		children.push(node);
		childrenByParent.set(node.parentId, children);
	}

	const positioned = new Map<string, InstanceTreeLayoutNode>();
	const ranks = new Map<string, number>();
	let nextLane = 0;
	function position(node: InstanceTreeNodeSummary): InstanceTreeLayoutNode {
		const existing = positioned.get(node.id);
		if (existing) return existing;
		const parentNode = node.parentId ? byId.get(node.parentId) : undefined;
		const parent = parentNode ? position(parentNode) : undefined;
		const siblings = node.parentId ? (childrenByParent.get(node.parentId) ?? []) : [];
		const startsLane = !parent || node.pathType === "leaf_branch" || siblings[0]?.id !== node.id;
		const lane = startsLane ? nextLane++ : parent.lane;
		const rank = parent ? (ranks.get(parent.id) ?? 0) + 1 : 0;
		ranks.set(node.id, rank);
		const result: InstanceTreeLayoutNode = {
			...node,
			x:
				HORIZONTAL_MARGIN +
				LANE_LABEL_WIDTH +
				NODE_WIDTH / 2 +
				rank * (NODE_WIDTH + INSTANCE_TREE_COLUMN_GAP),
			y: VERTICAL_MARGIN + NODE_HEIGHT / 2 + lane * (NODE_HEIGHT + LANE_GAP),
			width: NODE_WIDTH,
			height: NODE_HEIGHT,
			lane,
			startsLane,
			contextOrigin: startsLane ? (parent ? "previous" : "fresh") : null,
			childCount: childrenByParent.get(node.id)?.length ?? 0,
			isCurrent: node.id === currentLeafId,
		};
		positioned.set(node.id, result);
		return result;
	}
	const layoutNodes = sorted.map(position);
	const edges = edgeSummaries
		.map((edge) => {
			const source = positioned.get(edge.sourceNodeId);
			const target = edge.targetNodeId ? positioned.get(edge.targetNodeId) : null;
			if (!source || (edge.targetNodeId && !target)) return null;
			if (edge.endState) {
				return {
					...edge,
					points: [
						{ x: source.x + source.width / 2, y: source.y },
						{ x: source.x + source.width / 2 + 42, y: source.y },
						{ x: source.x + source.width / 2 + 82, y: source.y + 38 },
					],
				};
			}
			return target ? { ...edge, points: edgePathPoints(edge, source, target) } : null;
		})
		.filter((edge): edge is InstanceTreeLayoutEdge => Boolean(edge));
	const maxRank = Math.max(...ranks.values());
	return {
		width:
			HORIZONTAL_MARGIN * 2 +
			LANE_LABEL_WIDTH +
			(maxRank + 1) * NODE_WIDTH +
			maxRank * INSTANCE_TREE_COLUMN_GAP +
			(edges.some((edge) => edge.endState) ? 100 : 0),
		height: VERTICAL_MARGIN * 2 + nextLane * NODE_HEIGHT + Math.max(0, nextLane - 1) * LANE_GAP,
		laneCount: nextLane,
		nodes: layoutNodes,
		edges,
	};
}
