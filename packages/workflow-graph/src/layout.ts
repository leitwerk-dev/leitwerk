import type {
	ProcessFlowEdge,
	ProcessFlowNode,
	ProcessFlowView,
	ProcessTurnType,
} from "@leitwerk-dev/domain";

/** @internal */
export interface Point {
	/** @internal */ x: number;
	/** @internal */ y: number;
}
/** @internal */
export interface RepeatGeometry {
	/** @internal */ activity: {
		/** @internal */ x: number;
		/** @internal */ y: number;
		/** @internal */ width: number;
		/** @internal */ height: number;
	};
	/** @internal */ collector: Point;
	/** @internal */ axis: number;
	/** @internal */ loopY: number;
}
/** @internal */
export interface WorkflowNode {
	/** @internal */ id: string;
	/** @internal */ turnId: string | null;
	/** @internal */ title: string;
	/** @internal */ kind: ProcessTurnType | "completed" | "aborted";
	/** @internal */ definition: ProcessFlowNode | null;
	/** @internal */ synthetic: boolean;
	/** @internal */ column: number;
	/** @internal */ lane: number;
	/** @internal */ x: number;
	/** @internal */ y: number;
	/** @internal */ width: number;
	/** @internal */ height: number;
	/** @internal */ repeat: RepeatGeometry | null;
}
/** @internal */
type Side = "left" | "right" | "top" | "bottom";
/** @internal */
export interface WorkflowEdge {
	/** @internal */ id: string;
	/** @internal */ from: string;
	/** @internal */ to: string;
	/** @internal */ label: string | null;
	/** @internal */ condition?: ProcessFlowEdge["condition"];
	/** @internal */ kind: ProcessFlowEdge["kind"];
	/** @internal */ points: Point[];
	/** @internal */ labelPosition: Point;
	/** @internal */ sourceSide: Side;
	/** @internal */ targetSide: Side;
}
/** @internal */
export interface WorkflowLayout {
	/** @internal */ width: number;
	/** @internal */ height: number;
	/** @internal */ nodes: WorkflowNode[];
	/** @internal */ edges: WorkflowEdge[];
	/** Layout node identities, including the completed terminal. @internal */ mainPath: string[];
}

const turnId = (id: string) => `turn:${id}`;
const endId = (status: string) => `end:${status}`;

/** Stable breadth-first search; abort and declared happy-path hints cannot shorten success. @internal */
export function shortestSuccessfulPath(flow: ProcessFlowView): string[] {
	const ids = new Set(flow.nodes.map((node) => node.turnId));
	const entry = flow.entryTurnIds.find((id) => ids.has(id)) ?? flow.nodes[0]?.turnId;
	if (!entry) return [];
	const parents = new Map<string, string | null>([[entry, null]]);
	const queue = [entry];
	for (const id of queue) {
		const outgoing = flow.edges.filter((edge) => edge.from === id);
		if (outgoing.some((edge) => edge.lifecycleStatus === "completed")) {
			const path: string[] = [];
			let cursor: string | null = id;
			while (cursor !== null) {
				path.push(cursor);
				cursor = parents.get(cursor) ?? null;
			}
			return path.reverse();
		}
		for (const edge of outgoing) {
			if (edge.to === null || !ids.has(edge.to) || parents.has(edge.to)) continue;
			parents.set(edge.to, id);
			queue.push(edge.to);
		}
	}
	return [entry];
}

/** Labels match the Chronicle's turn-kind vocabulary. @internal */
export function turnKindLabel(kind: WorkflowNode["kind"]): string {
	switch (kind) {
		case "llm":
			return "LLM turn";
		case "automatic":
			return "Automation";
		case "human":
			return "Operator decision";
		case "external":
			return "External wait";
		case "completed":
			return "Completed";
		case "aborted":
			return "Aborted";
	}
}

function makeNode(definition: ProcessFlowNode): WorkflowNode {
	const repeated = definition.repetition === "sequential";
	const width = repeated ? 380 : definition.description.length > 50 ? 260 : 225;
	const lines = Math.min(
		3,
		Math.max(1, Math.ceil(definition.description.length / (repeated ? 23 : 24))),
	);
	const activityHeight = 85 + (lines - 1) * 21;
	const height = repeated ? activityHeight + 115 : Math.max(112, 90 + lines * 21);
	return {
		id: turnId(definition.turnId),
		turnId: definition.turnId,
		title: definition.description,
		kind: definition.turnType,
		definition,
		synthetic: false,
		column: 0,
		lane: 0,
		x: 0,
		y: 0,
		width,
		height,
		repeat: repeated
			? {
					activity: { x: 18, y: 57.5, width: 235, height: activityHeight },
					collector: { x: 326, y: height / 2 },
					axis: height / 2,
					loopY: height - 22,
				}
			: null,
	};
}

/** Places the shortest successful path on one line and routes every declared transition. @internal */
export function layoutWorkflow(flow: ProcessFlowView): WorkflowLayout {
	const nodes = flow.nodes.map(makeNode);
	const statuses = new Map(flow.endStates.map((state) => [state.lifecycleStatus, state.synthetic]));
	for (const edge of flow.edges)
		if (edge.lifecycleStatus) statuses.set(edge.lifecycleStatus, false);
	for (const [status, synthetic] of statuses)
		nodes.push({
			id: endId(status),
			turnId: null,
			title: turnKindLabel(status),
			kind: status,
			definition: null,
			synthetic,
			column: 0,
			lane: 0,
			x: 0,
			y: 0,
			width: 190,
			height: 70,
			repeat: null,
		});
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const spine = shortestSuccessfulPath(flow);
	const mainPath = spine.map(turnId);
	if (flow.edges.some((edge) => edge.from === spine.at(-1) && edge.lifecycleStatus === "completed"))
		mainPath.push(endId("completed"));
	const edges: WorkflowEdge[] = flow.edges.flatMap((edge, index) => {
		const from = turnId(edge.from);
		const to =
			edge.to !== null
				? turnId(edge.to)
				: edge.lifecycleStatus
					? endId(edge.lifecycleStatus)
					: null;
		return to && byId.has(from) && byId.has(to)
			? [
					{
						id: `route-${index}`,
						from,
						to,
						label: edge.label,
						...(edge.condition ? { condition: edge.condition } : {}),
						kind: edge.kind,
						points: [],
						labelPosition: { x: 0, y: 0 },
						sourceSide: "right" as const,
						targetSide: "left" as const,
					},
				]
			: [];
	});
	const placed = new Set<string>();
	const occupied = new Set<string>();
	const place = (id: string, column: number, lane: number) => {
		const node = byId.get(id);
		if (!node || placed.has(id)) return;
		while (occupied.has(`${column}:${lane}`)) lane += lane < 0 ? -1 : 1;
		node.column = column;
		node.lane = lane;
		placed.add(id);
		occupied.add(`${column}:${lane}`);
	};
	for (const [column, id] of mainPath.entries()) place(id, column, 0);
	const queue = [...mainPath];
	for (const id of queue) {
		const parent = byId.get(id);
		if (!parent) continue;
		for (const edge of edges.filter((edge) => edge.from === id)) {
			const next = byId.get(edge.to);
			if (!next || placed.has(next.id)) continue;
			place(
				next.id,
				parent.column + 1,
				parent.lane || (next.kind === "human" || next.kind === "aborted" ? -1 : 1),
			);
			queue.push(next.id);
		}
	}
	// Unreachable declarations and implicit abort remain visible without fabricated edges.
	for (const node of nodes)
		if (!placed.has(node.id))
			place(node.id, node.synthetic ? Math.max(0, mainPath.length - 1) : 0, 1);
	for (const edge of edges) {
		const from = byId.get(edge.from) as WorkflowNode;
		const to = byId.get(edge.to) as WorkflowNode;
		// A side path may rejoin to its left without repeating any work.
		if (to.column <= from.column && canReach(edge.to, edge.from, edges)) edge.kind = "loopback";
	}
	const columnCount = Math.max(0, ...nodes.map((node) => node.column)) + 1;
	const widths = Array.from({ length: columnCount }, (_, column) =>
		Math.max(225, ...nodes.filter((node) => node.column === column).map((node) => node.width)),
	);
	const columns: number[] = [];
	let x = 50;
	for (const width of widths) {
		columns.push(x);
		x += width + 115;
	}
	const lanes = [...new Set(nodes.map((node) => node.lane))].sort((a, b) => a - b);
	const laneCenters = new Map<number, number>();
	let y = 90 + edges.filter((edge) => edge.kind === "loopback").length * 22;
	for (const lane of lanes) {
		const height = Math.max(
			130,
			...nodes.filter((node) => node.lane === lane).map((node) => node.height),
		);
		laneCenters.set(lane, y + height / 2);
		y += height + 85;
	}
	for (const node of nodes) {
		node.x = columns[node.column] + (widths[node.column] - node.width) / 2;
		node.y = (laneCenters.get(node.lane) ?? 0) - node.height / 2;
	}
	for (const edge of edges) {
		const from = byId.get(edge.from) as WorkflowNode;
		const to = byId.get(edge.to) as WorkflowNode;
		if (edge.kind === "loopback") {
			edge.sourceSide = "top";
			edge.targetSide = "top";
		} else if (from.column === to.column) {
			edge.sourceSide = from.y < to.y ? "bottom" : "top";
			edge.targetSide = from.y < to.y ? "top" : "bottom";
		} else if (from.lane === to.lane) {
			edge.sourceSide = "right";
			edge.targetSide = "left";
		} else if (to.lane !== 0 && from.lane === 0) {
			edge.sourceSide = to.lane < from.lane ? "top" : "bottom";
			edge.targetSide = "left";
		} else if (from.lane !== 0 && to.lane === 0) {
			edge.sourceSide = to.lane < from.lane ? "top" : "bottom";
			edge.targetSide = to.lane < from.lane ? "bottom" : "top";
		} else {
			edge.sourceSide = to.column < from.column ? "left" : "right";
			edge.targetSide = to.column < from.column ? "right" : "left";
		}
	}
	const port = (edge: WorkflowEdge, source: boolean): Point => {
		const node = byId.get(source ? edge.from : edge.to) as WorkflowNode;
		const side = source ? edge.sourceSide : edge.targetSide;
		const horizontal = side === "left" || side === "right";
		// Incoming and outgoing connections share one port allocation per side.
		// Repeats already separate incoming activity ports from outgoing collection ports.
		const peers = edges
			.flatMap((other) => [
				...(other.from === node.id && other.sourceSide === side && (!node.repeat || source)
					? [{ edge: other, source: true, opposite: byId.get(other.to) as WorkflowNode }]
					: []),
				...(other.to === node.id && other.targetSide === side && (!node.repeat || !source)
					? [{ edge: other, source: false, opposite: byId.get(other.from) as WorkflowNode }]
					: []),
			])
			.sort((a, b) => {
				const first = a.opposite;
				const second = b.opposite;
				const distance = horizontal
					? first.y + first.height / 2 - (second.y + second.height / 2)
					: first.x + first.width / 2 - (second.x + second.width / 2);
				return distance || Number(a.source) - Number(b.source);
			});
		const primary = peers.find(
			({ edge: other }) =>
				mainPath.indexOf(other.from) >= 0 &&
				mainPath[mainPath.indexOf(other.from) + 1] === other.to,
		);
		const center = primary ? peers.indexOf(primary) : (peers.length - 1) / 2;
		const available = horizontal
			? (node.repeat?.activity.height ?? node.height) / 2 - 16
			: node.repeat
				? source
					? 28
					: 10
				: node.width / 2 - 52;
		const spacing = Math.min(32, available / Math.max(1, center, peers.length - 1 - center));
		const index = peers.findIndex((peer) => peer.edge === edge && peer.source === source);
		const spread = (index - center) * spacing;
		const cx =
			node.x +
			(node.repeat
				? source
					? 326
					: 240
				: node.width / 2 + (edge.from === edge.to ? (source ? 36 : -36) : 0));
		const cy = node.y + node.height / 2;
		if (side === "left") return { x: node.x, y: cy + spread };
		if (side === "right") return { x: node.x + node.width, y: cy + spread };
		return { x: cx + spread, y: side === "top" ? node.y : node.y + node.height };
	};
	let loopIndex = 0;
	const routed: Point[][] = [];
	// Main-line edges get the unobstructed central ports before side routes.
	const isMain = (edge: WorkflowEdge) =>
		mainPath.indexOf(edge.from) >= 0 && mainPath[mainPath.indexOf(edge.from) + 1] === edge.to;
	for (const edge of [...edges].sort((a, b) => Number(isMain(b)) - Number(isMain(a)))) {
		const start = port(edge, true),
			end = port(edge, false);
		const from = escapePort(start, edge.sourceSide),
			to = escapePort(end, edge.targetSide);
		const rejoinsMainPath = byId.get(edge.from)?.lane !== 0 && byId.get(edge.to)?.lane === 0;
		const preferredY =
			edge.kind === "loopback"
				? 28 + loopIndex++ * 22
				: rejoinsMainPath &&
						(edge.sourceSide === "top" || edge.sourceSide === "bottom") &&
						(edge.targetSide === "top" || edge.targetSide === "bottom")
					? (start.y + end.y) / 2
					: undefined;
		const middle = route(from, to, nodes, routed, preferredY);
		edge.points = simplify([start, ...middle, end]);
		routed.push(edge.points);
		edge.labelPosition = routeLabel(edge.points);
	}
	return { width: x - 65, height: y - 35, nodes, edges, mainPath };
}

function canReach(start: string, target: string, edges: WorkflowEdge[]): boolean {
	const visited = new Set([start]);
	for (const id of visited) {
		if (id === target) return true;
		for (const edge of edges) if (edge.from === id) visited.add(edge.to);
	}
	return false;
}

function escapePort(point: Point, side: Side): Point {
	return {
		x: point.x + (side === "right" ? 20 : side === "left" ? -20 : 0),
		y: point.y + (side === "bottom" ? 20 : side === "top" ? -20 : 0),
	};
}
function simplify(points: Point[]): Point[] {
	const result: Point[] = [];
	for (const point of points) {
		const last = result.at(-1),
			before = result.at(-2);
		if (last && last.x === point.x && last.y === point.y) continue;
		if (
			before &&
			last &&
			((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))
		)
			result.pop();
		result.push(point);
	}
	return result;
}
function clearSegment(a: Point, b: Point, nodes: WorkflowNode[]): boolean {
	return !nodes.some((node) =>
		a.y === b.y
			? a.y > node.y - 10 &&
				a.y < node.y + node.height + 10 &&
				Math.max(a.x, b.x) > node.x - 10 &&
				Math.min(a.x, b.x) < node.x + node.width + 10
			: a.x > node.x - 10 &&
				a.x < node.x + node.width + 10 &&
				Math.max(a.y, b.y) > node.y - 10 &&
				Math.min(a.y, b.y) < node.y + node.height + 10,
	);
}
function route(
	start: Point,
	end: Point,
	nodes: WorkflowNode[],
	previous: Point[][],
	preferredY?: number,
): Point[] {
	const xs = [
		...new Set([
			start.x,
			end.x,
			...nodes.flatMap((node) => [node.x - 25, node.x + node.width + 25]),
		]),
	];
	const ys = [
		...new Set([
			start.y,
			end.y,
			preferredY ?? 28,
			...nodes.flatMap((node) => [node.y - 25, node.y + node.height + 25]),
		]),
	];
	const candidates =
		preferredY !== undefined
			? [[start, { x: start.x, y: preferredY }, { x: end.x, y: preferredY }, end]]
			: [
					...(start.x === end.x || start.y === end.y ? [[start, end]] : []),
					[start, { x: start.x, y: end.y }, end],
					[start, { x: end.x, y: start.y }, end],
					...xs.map((x) => [start, { x, y: start.y }, { x, y: end.y }, end]),
					...ys.map((y) => [start, { x: start.x, y }, { x: end.x, y }, end]),
				];
	const legal = candidates
		.map(simplify)
		.filter((points) =>
			points.slice(1).every((point, index) => clearSegment(points[index], point, nodes)),
		);
	const score = (points: Point[]) =>
		points.slice(1).reduce((sum, point, index) => {
			const before = points[index];
			const crossings = previous.reduce(
				(count, route) =>
					count +
					route.slice(1).filter((b, i) => {
						const a = route[i];
						return before.y === point.y && a.x === b.x
							? a.x > Math.min(before.x, point.x) &&
									a.x < Math.max(before.x, point.x) &&
									before.y > Math.min(a.y, b.y) &&
									before.y < Math.max(a.y, b.y)
							: before.x === point.x &&
									a.y === b.y &&
									a.y > Math.min(before.y, point.y) &&
									a.y < Math.max(before.y, point.y) &&
									before.x > Math.min(a.x, b.x) &&
									before.x < Math.max(a.x, b.x);
					}).length,
				0,
			);
			return sum + Math.abs(before.x - point.x) + Math.abs(before.y - point.y) + crossings * 80;
		}, points.length * 12);
	legal.sort((a, b) => score(a) - score(b));
	return legal[0] ?? gridRoute(start, end, xs, ys, nodes);
}

// Unusual cross-links can require more bends than the simple candidates above.
function gridRoute(
	start: Point,
	end: Point,
	xs: number[],
	ys: number[],
	nodes: WorkflowNode[],
): Point[] {
	xs.sort((a, b) => a - b);
	ys.sort((a, b) => a - b);
	const indexOf = (p: Point) => ys.indexOf(p.y) * xs.length + xs.indexOf(p.x);
	const pointAt = (index: number) => ({
		x: xs[index % xs.length],
		y: ys[Math.floor(index / xs.length)],
	});
	const first = indexOf(start),
		last = indexOf(end);
	const open = new Set([first]);
	const costs = new Map([[first, 0]]),
		parents = new Map<number, number>();
	while (open.size) {
		let current = first,
			best = Number.POSITIVE_INFINITY;
		for (const index of open) {
			const point = pointAt(index);
			const cost = (costs.get(index) ?? 0) + Math.abs(point.x - end.x) + Math.abs(point.y - end.y);
			if (cost < best) {
				current = index;
				best = cost;
			}
		}
		if (current === last) {
			const points = [end];
			while (parents.has(current)) {
				current = parents.get(current) as number;
				points.push(pointAt(current));
			}
			return simplify(points.reverse());
		}
		open.delete(current);
		const point = pointAt(current),
			xi = current % xs.length,
			yi = Math.floor(current / xs.length);
		for (const [nx, ny] of [
			[xi - 1, yi],
			[xi + 1, yi],
			[xi, yi - 1],
			[xi, yi + 1],
		]) {
			if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
			const next = ny * xs.length + nx,
				target = pointAt(next);
			if (!clearSegment(point, target, nodes)) continue;
			const cost =
				(costs.get(current) ?? 0) + Math.abs(point.x - target.x) + Math.abs(point.y - target.y);
			if (cost >= (costs.get(next) ?? Number.POSITIVE_INFINITY)) continue;
			parents.set(next, current);
			costs.set(next, cost);
			open.add(next);
		}
	}
	// Every node has separated lanes and columns, so outer corridors remain open.
	throw new Error("Workflow route has no clear corridor");
}
function routeLabel(points: Point[]): Point {
	let longest = -1,
		position = points[0] ?? { x: 0, y: 0 };
	for (let index = 1; index < points.length; index++) {
		const a = points[index - 1],
			b = points[index],
			length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
		if (length <= longest) continue;
		longest = length;
		position = {
			x: (a.x + b.x) / 2 + (a.x === b.x ? 44 : 0),
			y: (a.y + b.y) / 2 - (a.y === b.y ? 16 : 0),
		};
	}
	return position;
}
/** Orthogonal SVG path with no smoothing that can displace aligned ports. @internal */
export function edgePath(points: readonly Point[]): string {
	return points
		.map((point, index) =>
			!index
				? `M${point.x} ${point.y}`
				: point.x === points[index - 1].x
					? `V${point.y}`
					: point.y === points[index - 1].y
						? `H${point.x}`
						: `L${point.x} ${point.y}`,
		)
		.join("");
}
