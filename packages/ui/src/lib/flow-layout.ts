import dagre from "@dagrejs/dagre";
import type {
	ProcessFlowEdge,
	ProcessFlowNode,
	ProcessFlowView,
	ProcessTurnTerminalLifecycleStatus,
	ProcessTurnType,
} from "@leitwerk-dev/domain";

export type FlowLayoutNodeKind = "turn" | "end";

export interface FlowLayoutPoint {
	x: number;
	y: number;
}

export interface FlowLayoutNode {
	id: string;
	kind: FlowLayoutNodeKind;
	x: number;
	y: number;
	width: number;
	height: number;
	title: string;
	subtitle: string;
	role: ProcessFlowNode["role"] | null;
	turnType: ProcessTurnType | null;
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus | null;
	isEntry: boolean;
}

export interface FlowLayoutEdge {
	id: string;
	from: string;
	to: string;
	kind: ProcessFlowEdge["kind"];
	/**
	 * All transition labels merged into this single visual edge. Parallel
	 * transitions between the same two boxes (same kind) are combined into one
	 * drawn edge, so this holds every underlying transition label.
	 */
	labels: string[];
	points: FlowLayoutPoint[];
	labelX: number | null;
	labelY: number | null;
}

export interface FlowLayout {
	width: number;
	height: number;
	nodes: FlowLayoutNode[];
	edges: FlowLayoutEdge[];
}

export interface FlowLayoutOptions {
	/** Average glyph advance used to estimate box width without DOM measurement. */
	charWidth?: number;
	minNodeWidth?: number;
	maxNodeWidth?: number;
	nodeHeight?: number;
	endNodeHeight?: number;
	/** Horizontal padding inside a box. */
	nodePaddingX?: number;
	rankSep?: number;
	nodeSep?: number;
	edgeSep?: number;
	edgeLabelCharWidth?: number;
	edgeLabelHeight?: number;
}

const DEFAULTS = {
	charWidth: 7.2,
	minNodeWidth: 132,
	maxNodeWidth: 280,
	nodeHeight: 56,
	endNodeHeight: 44,
	nodePaddingX: 28,
	rankSep: 56,
	nodeSep: 36,
	edgeSep: 18,
	edgeLabelCharWidth: 6,
	edgeLabelHeight: 18,
} as const;

const END_NODE_PREFIX = "__end__";

export function endNodeId(status: ProcessTurnTerminalLifecycleStatus): string {
	return `${END_NODE_PREFIX}${status}`;
}

function endNodeTitle(status: ProcessTurnTerminalLifecycleStatus): string {
	return status === "completed" ? "Completed" : "Aborted";
}

/**
 * Short text drawn on a merged edge: the single label when only one transition
 * was merged, or a self-describing `N transitions` count when several share the
 * edge. The full list is exposed separately for a hover tooltip.
 */
export function edgeDisplayLabel(labels: readonly string[]): string {
	if (labels.length === 0) {
		return "";
	}
	if (labels.length === 1) {
		return labels[0];
	}
	return `${labels.length} transitions`;
}

/** Short operator-facing name for a turn type, used as a node subtitle and in summaries. */
export function turnTypeLabel(turnType: ProcessTurnType): string {
	switch (turnType) {
		case "llm":
			return "Agent turn";
		case "human":
			return "Operator decision";
		case "external":
			return "External wait";
		case "automatic":
			return "Automatic";
		case "server_automatic":
			return "Server step";
	}
}

/**
 * Single source of truth for the operator-facing explanation of each turn type,
 * surfaced as a hover tooltip on flow-diagram nodes. Keep these aligned with the
 * short {@link turnTypeLabel} names.
 */
export function turnTypeDescription(turnType: ProcessTurnType): string {
	switch (turnType) {
		case "llm":
			return "An AI agent does the work in this step, using its tools to plan, edit, or review.";
		case "human":
			return "You decide how the process continues by choosing one of the available actions.";
		case "external":
			return "The process pauses until an outside system or event reports back.";
		case "automatic":
			return "A deterministic step runs automatically in the workspace, with no AI or operator input.";
		case "server_automatic":
			return "The server runs this step automatically to prepare or finalize process state.";
	}
}

function estimateWidth(
	text: string,
	options: Required<FlowLayoutOptions>,
	charWidth = options.charWidth,
): number {
	const raw = text.length * charWidth + options.nodePaddingX * 2;
	return Math.max(options.minNodeWidth, Math.min(options.maxNodeWidth, Math.round(raw)));
}

/**
 * Computes a layered graph layout for a process flow view using dagre.
 * Every node and every edge in the view is laid out — including loops, branch
 * offshoots, and multiple edges into or out of a single box — so the result can
 * be rendered as a real directed flow chart rather than a linear list.
 * The layout is deterministic for a given input and option set, so it can be
 * asserted in unit tests without a DOM.
 */
export function computeFlowLayout(
	view: ProcessFlowView,
	options: FlowLayoutOptions = {},
): FlowLayout {
	const opts: Required<FlowLayoutOptions> = { ...DEFAULTS, ...options };

	const graph = new dagre.graphlib.Graph({ multigraph: true });
	graph.setGraph({
		rankdir: "TB",
		ranksep: opts.rankSep,
		nodesep: opts.nodeSep,
		edgesep: opts.edgeSep,
		marginx: 12,
		marginy: 12,
	});
	graph.setDefaultEdgeLabel(() => ({}));

	const turnNodes = new Map<string, ProcessFlowNode>();
	for (const node of view.nodes) {
		turnNodes.set(node.turnId, node);
		const width = estimateWidth(node.description, opts);
		graph.setNode(node.turnId, { width, height: opts.nodeHeight });
	}

	// Terminal end-state boxes that real transitions point into.
	const endStatuses = new Set<ProcessTurnTerminalLifecycleStatus>();
	for (const edge of view.edges) {
		if (edge.lifecycleStatus !== null) {
			endStatuses.add(edge.lifecycleStatus);
		}
	}
	for (const status of endStatuses) {
		const title = endNodeTitle(status);
		graph.setNode(endNodeId(status), {
			width: estimateWidth(title, opts),
			height: opts.endNodeHeight,
		});
	}

	// Merge parallel transitions between the same two boxes (same kind) into a
	// single drawn edge, collecting every underlying label. This keeps the chart
	// readable: N transitions from A to B become one arrow, not N overlapping ones.
	type EdgeGroup = {
		from: string;
		target: string;
		kind: ProcessFlowEdge["kind"];
		labels: string[];
	};
	const edgeGroups = new Map<string, EdgeGroup>();
	for (const edge of view.edges) {
		const target = edge.to ?? (edge.lifecycleStatus ? endNodeId(edge.lifecycleStatus) : null);
		if (target === null || !graph.hasNode(edge.from) || !graph.hasNode(target)) {
			continue;
		}
		const key = `${edge.from}|${target}|${edge.kind}`;
		const existing = edgeGroups.get(key);
		if (existing) {
			if (edge.label && !existing.labels.includes(edge.label)) {
				existing.labels.push(edge.label);
			}
			continue;
		}
		edgeGroups.set(key, {
			from: edge.from,
			target,
			kind: edge.kind,
			labels: edge.label ? [edge.label] : [],
		});
	}

	type EdgeMeta = { kind: ProcessFlowEdge["kind"]; labels: string[] };
	const edgeMeta = new Map<string, EdgeMeta>();
	let edgeIndex = 0;
	for (const group of edgeGroups.values()) {
		const name = `e${edgeIndex}`;
		edgeIndex += 1;
		const display = edgeDisplayLabel(group.labels);
		const labelConfig = display
			? {
					width: Math.round(display.length * opts.edgeLabelCharWidth),
					height: opts.edgeLabelHeight,
					labelpos: "c" as const,
				}
			: {};
		graph.setEdge(group.from, group.target, labelConfig, name);
		edgeMeta.set(`${group.from}|${group.target}|${name}`, {
			kind: group.kind,
			labels: group.labels,
		});
	}

	dagre.layout(graph);

	const graphLabel = graph.graph();
	const layoutNodes: FlowLayoutNode[] = [];
	for (const id of graph.nodes()) {
		const dagreNode = graph.node(id);
		if (!dagreNode) {
			continue;
		}
		const turn = turnNodes.get(id);
		if (turn) {
			layoutNodes.push({
				id,
				kind: "turn",
				x: dagreNode.x,
				y: dagreNode.y,
				width: dagreNode.width,
				height: dagreNode.height,
				title: turn.description,
				subtitle: turnTypeLabel(turn.turnType),
				role: turn.role,
				turnType: turn.turnType,
				lifecycleStatus: null,
				isEntry: turn.isEntry,
			});
			continue;
		}
		const status: ProcessTurnTerminalLifecycleStatus = id.endsWith("completed")
			? "completed"
			: "aborted";
		layoutNodes.push({
			id,
			kind: "end",
			x: dagreNode.x,
			y: dagreNode.y,
			width: dagreNode.width,
			height: dagreNode.height,
			title: endNodeTitle(status),
			subtitle: "End state",
			role: null,
			turnType: null,
			lifecycleStatus: status,
			isEntry: false,
		});
	}

	const layoutEdges: FlowLayoutEdge[] = [];
	for (const edgeObj of graph.edges()) {
		const dagreEdge = graph.edge(edgeObj);
		if (!dagreEdge) {
			continue;
		}
		const meta = edgeMeta.get(`${edgeObj.v}|${edgeObj.w}|${edgeObj.name}`);
		const points = (dagreEdge.points ?? []).map((point) => ({ x: point.x, y: point.y }));
		layoutEdges.push({
			id: edgeObj.name ?? `${edgeObj.v}-${edgeObj.w}`,
			from: edgeObj.v,
			to: edgeObj.w,
			kind: meta?.kind ?? "forward",
			labels: meta?.labels ?? [],
			points,
			labelX: typeof dagreEdge.x === "number" ? dagreEdge.x : null,
			labelY: typeof dagreEdge.y === "number" ? dagreEdge.y : null,
		});
	}

	return {
		width: typeof graphLabel.width === "number" ? graphLabel.width : 0,
		height: typeof graphLabel.height === "number" ? graphLabel.height : 0,
		nodes: layoutNodes,
		edges: layoutEdges,
	};
}
