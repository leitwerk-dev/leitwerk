import {
	humanizeProcessLabel,
	type ProcessFlowEdge,
	type ProcessFlowEndState,
	type ProcessFlowNode,
	type ProcessFlowView,
	type ProcessTurnTerminalLifecycleStatus,
	type ProcessTurnTransition,
	type TurnId,
} from "@leitwerk-dev/domain";
import type { ProcessGraphTurnView, ProcessGraphView } from "./process-graph.js";

function trimToNull(value: string | undefined | null): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

/**
 * Human/operator turns are routing decisions: they pick which path the process
 * takes but perform no work themselves. They are collapsed out of the flow graph
 * so the chart shows only work nodes (LLM/automatic/server) and end states, with
 * the operator's decision surfaced as the edge label between the real nodes.
 */
function isRoutingTurn(turn: ProcessGraphTurnView): boolean {
	return turn.turnType === "human";
}

/**
 * Picks the work turn an operator decision is *about* — its anchor. A decision is
 * both a join (many work turns lead into it) and a split (the operator picks one
 * of several actions). Folding the split onto every join predecessor would invent
 * an N×M mesh of work→work edges that no single step actually connects (e.g. a
 * "review implementation → simplify" edge that does not exist in the process).
 *
 * Instead, every operator decision collapses into exactly one anchor work node:
 *   - edges that lead *into* the decision are redirected to the anchor, and
 *   - the decision's action edges are emitted *from* the anchor.
 *
 * That yields N+M edges around one real node instead of N×M fabricated ones, and
 * every surviving edge still maps to a single declared transition with one human
 * hop folded into the work node that owns the decision.
 *
 * The anchor is the work predecessor the decision belongs to, preferring a
 * predecessor on the declared happy path (earliest position), then the earliest
 * declared work predecessor. Decisions reached only from other decisions inherit
 * their predecessor decision's anchor.
 */
function computeRoutingAnchors(
	graph: ProcessGraphView,
	routingIds: ReadonlySet<TurnId>,
): Map<TurnId, TurnId> {
	const declarationIndex = new Map<TurnId, number>();
	[...graph.turns.keys()].forEach((turnId, index) => {
		declarationIndex.set(turnId, index);
	});

	const happyIndex = new Map<TurnId, number>();
	(graph.happyPath ?? []).forEach((turnId, index) => {
		if (!happyIndex.has(turnId)) {
			happyIndex.set(turnId, index);
		}
	});

	const workPredecessors = new Map<TurnId, TurnId[]>();
	const routingPredecessors = new Map<TurnId, TurnId[]>();
	for (const routingId of routingIds) {
		workPredecessors.set(routingId, []);
		routingPredecessors.set(routingId, []);
	}
	for (const [turnId, turn] of graph.turns) {
		for (const transition of turn.transitions) {
			const next = transition.nextTurnId;
			if (next === undefined || !routingIds.has(next) || next === turnId) {
				continue;
			}
			if (routingIds.has(turnId)) {
				routingPredecessors.get(next)?.push(turnId);
			} else {
				workPredecessors.get(next)?.push(turnId);
			}
		}
	}

	const preferenceKey = (turnId: TurnId): [number, number] => [
		happyIndex.get(turnId) ?? Number.POSITIVE_INFINITY,
		declarationIndex.get(turnId) ?? Number.POSITIVE_INFINITY,
	];
	const pickPreferred = (candidates: readonly TurnId[]): TurnId | undefined => {
		let best: TurnId | undefined;
		let bestKey: [number, number] | undefined;
		for (const candidate of candidates) {
			const key = preferenceKey(candidate);
			if (
				bestKey === undefined ||
				key[0] < bestKey[0] ||
				(key[0] === bestKey[0] && key[1] < bestKey[1])
			) {
				best = candidate;
				bestKey = key;
			}
		}
		return best;
	};

	const anchors = new Map<TurnId, TurnId>();
	for (const routingId of routingIds) {
		const preferred = pickPreferred(workPredecessors.get(routingId) ?? []);
		if (preferred !== undefined) {
			anchors.set(routingId, preferred);
		}
	}

	// Decisions reached only from other decisions resolve transitively to the
	// anchor of a predecessor decision. Iterate to a fixpoint.
	let changed = true;
	while (changed) {
		changed = false;
		for (const routingId of routingIds) {
			if (anchors.has(routingId)) {
				continue;
			}
			for (const predecessor of routingPredecessors.get(routingId) ?? []) {
				const predecessorAnchor = anchors.get(predecessor);
				if (predecessorAnchor !== undefined) {
					anchors.set(routingId, predecessorAnchor);
					changed = true;
					break;
				}
			}
		}
	}

	// Any decision still unresolved (an isolated decision-only cluster) falls back
	// to the first declared work turn so the graph stays connected and deterministic.
	const fallbackWork = [...graph.turns.keys()].find((turnId) => !routingIds.has(turnId));
	if (fallbackWork !== undefined) {
		for (const routingId of routingIds) {
			if (!anchors.has(routingId)) {
				anchors.set(routingId, fallbackWork);
			}
		}
	}
	return anchors;
}

function redirectTransition(
	transition: ProcessTurnTransition,
	resolveWork: (turnId: TurnId) => TurnId,
): ProcessTurnTransition {
	const label = trimToNull(transition.outcome) ?? trimToNull(transition.trigger);
	if (transition.lifecycleStatus !== undefined) {
		return {
			lifecycleStatus: transition.lifecycleStatus,
			...(label ? { outcome: label } : {}),
		};
	}
	const next = transition.nextTurnId;
	if (next === undefined) {
		return { ...(label ? { outcome: label } : {}) };
	}
	return {
		nextTurnId: resolveWork(next),
		...(label ? { outcome: label } : {}),
	};
}

function dedupeTransitions(transitions: readonly ProcessTurnTransition[]): ProcessTurnTransition[] {
	const seen = new Set<string>();
	const result: ProcessTurnTransition[] = [];
	for (const transition of transitions) {
		const label = trimToNull(transition.outcome) ?? trimToNull(transition.trigger);
		const key = `${transition.nextTurnId ?? ""}|${transition.lifecycleStatus ?? ""}|${label ?? ""}`;
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(transition);
	}
	return result;
}

/**
 * Removes routing (human) turns from a process graph by merging each one into a
 * single anchor work node (see {@link computeRoutingAnchors}). Edges into a
 * decision are redirected to its anchor, and the decision's action edges are
 * re-emitted from that anchor. Self-loops produced by the merge are left in place
 * here and dropped later during edge construction. Entry turns and the declared
 * happy path are remapped/filtered to stay consistent.
 */
export function collapseRoutingTurns(graph: ProcessGraphView): ProcessGraphView {
	const routingIds = new Set<TurnId>();
	for (const [turnId, turn] of graph.turns) {
		if (isRoutingTurn(turn)) {
			routingIds.add(turnId);
		}
	}
	if (routingIds.size === 0) {
		return graph;
	}
	if (routingIds.size === graph.turns.size) {
		return graph;
	}

	const anchors = computeRoutingAnchors(graph, routingIds);
	const resolveWork = (turnId: TurnId): TurnId =>
		routingIds.has(turnId) ? (anchors.get(turnId) ?? turnId) : turnId;

	// Group each decision's action transitions onto its anchor work turn.
	const inheritedByAnchor = new Map<TurnId, ProcessTurnTransition[]>();
	for (const routingId of routingIds) {
		const anchor = anchors.get(routingId);
		if (anchor === undefined) {
			continue;
		}
		const routingTurn = graph.turns.get(routingId);
		if (!routingTurn) {
			continue;
		}
		const bucket = inheritedByAnchor.get(anchor) ?? [];
		for (const transition of routingTurn.transitions) {
			bucket.push(redirectTransition(transition, resolveWork));
		}
		inheritedByAnchor.set(anchor, bucket);
	}

	const turns = new Map<TurnId, ProcessGraphTurnView>();
	for (const [turnId, turn] of graph.turns) {
		if (routingIds.has(turnId)) {
			continue;
		}
		const transitions = [
			...turn.transitions.map((transition) => redirectTransition(transition, resolveWork)),
			...(inheritedByAnchor.get(turnId) ?? []),
		];
		turns.set(turnId, { ...turn, transitions: dedupeTransitions(transitions) });
	}

	const entryTurnIds = new Set<TurnId>();
	for (const entry of graph.entryTurnIds) {
		if (graph.turns.has(entry)) {
			entryTurnIds.add(resolveWork(entry));
		}
	}

	const filteredHappyPath = graph.happyPath?.filter((turnId) => !routingIds.has(turnId)) ?? null;

	return {
		id: graph.id,
		primaryEntryTurnId: resolveWork(graph.primaryEntryTurnId),
		entryTurnIds,
		happyPath: filteredHappyPath && filteredHappyPath.length > 0 ? filteredHappyPath : null,
		turns,
	};
}

/**
 * Best-effort spine when a process does not declare an explicit happy path.
 * Walks `nextTurnId` edges breadth-first from the entry turn to the nearest turn
 * that can reach a `completed` terminal, preferring the shortest forward path and
 * breaking ties by transition declaration order. Returns `[entry]` when no
 * completing path exists.
 */
function deriveSpine(graph: ProcessGraphView, entry: TurnId): TurnId[] {
	const turnsWithCompletedTerminal = new Set<TurnId>();
	for (const [turnId, turn] of graph.turns) {
		if (turn.transitions.some((transition) => transition.lifecycleStatus === "completed")) {
			turnsWithCompletedTerminal.add(turnId);
		}
	}
	if (turnsWithCompletedTerminal.size === 0) {
		return [entry];
	}

	const predecessor = new Map<TurnId, TurnId | null>([[entry, null]]);
	const queue: TurnId[] = [entry];
	let goal: TurnId | null = null;
	while (queue.length > 0) {
		const current = queue.shift() as TurnId;
		if (turnsWithCompletedTerminal.has(current)) {
			goal = current;
			break;
		}
		const turn = graph.turns.get(current);
		if (!turn) {
			continue;
		}
		for (const transition of turn.transitions) {
			const next = transition.nextTurnId;
			if (next === undefined || predecessor.has(next) || !graph.turns.has(next)) {
				continue;
			}
			predecessor.set(next, current);
			queue.push(next);
		}
	}

	if (goal === null) {
		return [entry];
	}
	const reversed: TurnId[] = [];
	let cursor: TurnId | null = goal;
	while (cursor !== null) {
		reversed.push(cursor);
		cursor = predecessor.get(cursor) ?? null;
	}
	return reversed.reverse();
}

/**
 * Assigns each non-spine turn to the spine node it hangs off. A branch is anchored
 * to the lowest-index spine node that can reach it without passing through another
 * spine node, so offshoots attach to the earliest spine step that launches them.
 */
function deriveBranchAnchors(
	graph: ProcessGraphView,
	spineIndexByTurn: ReadonlyMap<TurnId, number>,
): Map<TurnId, TurnId> {
	const anchorByTurn = new Map<TurnId, TurnId>();
	const orderedSpine = [...spineIndexByTurn.entries()]
		.sort((left, right) => left[1] - right[1])
		.map(([turnId]) => turnId);

	for (const spineTurnId of orderedSpine) {
		const stack: TurnId[] = [spineTurnId];
		const visited = new Set<TurnId>([spineTurnId]);
		while (stack.length > 0) {
			const current = stack.pop() as TurnId;
			const turn = graph.turns.get(current);
			if (!turn) {
				continue;
			}
			for (const transition of turn.transitions) {
				const next = transition.nextTurnId;
				if (next === undefined || !graph.turns.has(next) || visited.has(next)) {
					continue;
				}
				visited.add(next);
				if (spineIndexByTurn.has(next)) {
					// Stop at spine nodes; do not traverse through them.
					continue;
				}
				if (!anchorByTurn.has(next)) {
					anchorByTurn.set(next, spineTurnId);
				}
				stack.push(next);
			}
		}
	}
	return anchorByTurn;
}

function transitionLabel(transition: { outcome?: string; trigger?: string }): string | null {
	// Route every operator-facing edge label through the shared humanizer so the
	// diagram shows nice Title Case names (e.g. `approve_plan` -> `Approve Plan`),
	// consistent with action forms and ready for future localization.
	const raw = trimToNull(transition.outcome) ?? trimToNull(transition.trigger);
	return raw === null ? null : humanizeProcessLabel(raw);
}

function buildNode(input: {
	turnId: TurnId;
	turn: ProcessGraphTurnView;
	spineIndex: number | null;
	anchorTurnId: TurnId | null;
	isEntry: boolean;
}): ProcessFlowNode {
	return {
		turnId: input.turnId,
		description: trimToNull(input.turn.description) ?? input.turnId,
		turnType: input.turn.turnType,
		role: input.spineIndex === null ? "branch" : "spine",
		spineIndex: input.spineIndex,
		anchorTurnId: input.spineIndex === null ? input.anchorTurnId : null,
		isEntry: input.isEntry,
	};
}

/**
 * Projects a process graph into a spine-first flow view for operator-facing
 * diagrams. The spine is the declared happy path (or a derived best-effort path
 * when none is declared); every other turn hangs off the spine as a branch.
 * The `aborted` end state is always present because abort is reachable from any
 * active turn, even when no explicit transition targets it.
 */
export function buildProcessFlowView(rawGraph: ProcessGraphView): ProcessFlowView {
	const graph = collapseRoutingTurns(rawGraph);
	const entryTurnIds = [...graph.entryTurnIds].filter((turnId) => graph.turns.has(turnId));
	const primaryEntry = graph.turns.has(graph.primaryEntryTurnId)
		? graph.primaryEntryTurnId
		: [...graph.turns.keys()][0];

	const declaredSpine = graph.happyPath?.filter((turnId) => graph.turns.has(turnId)) ?? null;
	const spine =
		declaredSpine && declaredSpine.length > 0
			? [...declaredSpine]
			: primaryEntry !== undefined
				? deriveSpine(graph, primaryEntry)
				: [];

	const spineIndexByTurn = new Map<TurnId, number>();
	spine.forEach((turnId, index) => {
		spineIndexByTurn.set(turnId, index);
	});

	const anchorByTurn = deriveBranchAnchors(graph, spineIndexByTurn);
	const entrySet = new Set(entryTurnIds);

	const nodes: ProcessFlowNode[] = [];
	for (const [turnId, turn] of graph.turns) {
		const spineIndex = spineIndexByTurn.get(turnId) ?? null;
		nodes.push(
			buildNode({
				turnId,
				turn,
				spineIndex,
				anchorTurnId: anchorByTurn.get(turnId) ?? null,
				isEntry: entrySet.has(turnId),
			}),
		);
	}

	const edges: ProcessFlowEdge[] = [];
	const terminalStatuses = new Set<ProcessTurnTerminalLifecycleStatus>();
	for (const [turnId, turn] of graph.turns) {
		for (const transition of turn.transitions) {
			const label = transitionLabel(transition);
			if (transition.lifecycleStatus !== undefined) {
				terminalStatuses.add(transition.lifecycleStatus);
				edges.push({
					from: turnId,
					to: null,
					lifecycleStatus: transition.lifecycleStatus,
					kind: "terminal",
					label,
				});
				continue;
			}
			const next = transition.nextTurnId;
			if (next === undefined) {
				continue;
			}
			// Skip self-loops: an edge that leaves and re-enters the same box adds
			// clutter without conveying additional flow.
			if (next === turnId) {
				continue;
			}
			const fromIndex = spineIndexByTurn.get(turnId);
			const toIndex = spineIndexByTurn.get(next);
			let kind: ProcessFlowEdge["kind"];
			if (fromIndex !== undefined && toIndex !== undefined) {
				kind = toIndex === fromIndex + 1 ? "forward" : "loopback";
			} else {
				kind = "branch";
			}
			edges.push({ from: turnId, to: next, lifecycleStatus: null, kind, label });
		}
	}

	const endStates: ProcessFlowEndState[] = [];
	for (const status of terminalStatuses) {
		endStates.push({ lifecycleStatus: status, synthetic: false });
	}
	if (!terminalStatuses.has("aborted")) {
		endStates.push({ lifecycleStatus: "aborted", synthetic: true });
	}
	endStates.sort((left, right) => left.lifecycleStatus.localeCompare(right.lifecycleStatus));

	return {
		processId: graph.id,
		entryTurnIds,
		spine,
		nodes,
		edges,
		endStates,
	};
}
