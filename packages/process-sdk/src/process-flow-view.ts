import {
	humanizeProcessLabel,
	type ProcessFlowEdge,
	type ProcessFlowEndState,
	type ProcessFlowNode,
	type ProcessFlowView,
	type ProcessTurnTerminalLifecycleStatus,
	type TurnId,
	trimToNull,
} from "@leitwerk-dev/domain";
import type { ProcessGraphView } from "./process-graph.js";

/**
 * The shortest successful route, independent of the authored happy-path hint.
 * Walks `nextTurnId` edges breadth-first from the entry turn to the nearest turn
 * that can reach a `completed` terminal, preferring the shortest forward path and
 * breaking ties by transition declaration order. Returns `[entry]` when no
 * completing path exists.
 */
function deriveSpine(graph: ProcessGraphView, entry: TurnId): TurnId[] {
	const predecessor = new Map<TurnId, TurnId | null>([[entry, null]]);
	const queue: TurnId[] = [entry];
	let goal: TurnId | null = null;
	for (const current of queue) {
		const turn = graph.turns.get(current);
		if (!turn) {
			continue;
		}
		if (turn.transitions.some((transition) => transition.lifecycleStatus === "completed")) {
			goal = current;
			break;
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

function transitionLabel(
	transition: { outcome?: string; trigger?: string },
	labels?: Readonly<Record<string, string>>,
): string | null {
	if (transition.trigger && labels?.[transition.trigger]) return labels[transition.trigger];
	// Route every operator-facing edge label through the shared humanizer so the
	// diagram shows nice Title Case names (e.g. `approve_plan` -> `Approve Plan`),
	// consistent with action forms and ready for future localization.
	const raw = trimToNull(transition.outcome) ?? trimToNull(transition.trigger);
	return raw === null ? null : humanizeProcessLabel(raw);
}

/**
 * Projects every declared turn and route. The shortest successful route defines
 * the spine; operator decisions and mapped turns each count as one turn.
 * The `aborted` end state is always present because abort is reachable from any
 * active turn, even when no explicit transition targets it.
 */
/** @internal */
export function buildProcessFlowView(graph: ProcessGraphView): ProcessFlowView {
	const entryTurnIds = [...graph.entryTurnIds].filter((turnId) => graph.turns.has(turnId));
	const primaryEntry = graph.turns.has(graph.primaryEntryTurnId)
		? graph.primaryEntryTurnId
		: [...graph.turns.keys()][0];

	const spine = primaryEntry !== undefined ? deriveSpine(graph, primaryEntry) : [];

	const spineIndexByTurn = new Map<TurnId, number>();
	spine.forEach((turnId, index) => {
		spineIndexByTurn.set(turnId, index);
	});

	const anchorByTurn = deriveBranchAnchors(graph, spineIndexByTurn);
	const entrySet = new Set(entryTurnIds);

	const nodes: ProcessFlowNode[] = [];
	for (const [turnId, turn] of graph.turns) {
		const spineIndex = spineIndexByTurn.get(turnId) ?? null;
		const inputs = [
			...new Set([
				...(turn.consumedProducts ?? []),
				...(turn.optionalConsumedProducts ?? []),
				...(turn.reviewProduct ? [turn.reviewProduct] : []),
			]),
		];
		const outputs = [
			...new Set([
				...(turn.publishedProducts ?? []),
				...(turn.publishedProduct ? [turn.publishedProduct] : []),
			]),
		];
		nodes.push({
			turnId,
			description: trimToNull(turn.description) ?? turnId,
			turnType: turn.turnType,
			role: spineIndex === null ? "branch" : "spine",
			spineIndex,
			anchorTurnId: spineIndex === null ? (anchorByTurn.get(turnId) ?? null) : null,
			isEntry: entrySet.has(turnId),
			...(turn.repetition ? { repetition: turn.repetition } : {}),
			...(turn.tools ? { tools: turn.tools.map((tool) => ({ ...tool })) } : {}),
			...(turn.hasDynamicTools ? { hasDynamicTools: true } : {}),
			...(inputs.length ? { inputProducts: inputs } : {}),
			...(outputs.length ? { outputProducts: outputs } : {}),
		});
	}

	const edges: ProcessFlowEdge[] = [];
	const terminalStatuses = new Set<ProcessTurnTerminalLifecycleStatus>();
	for (const [turnId, turn] of graph.turns) {
		for (const transition of turn.transitions) {
			const label = transitionLabel(transition, turn.transitionLabels);
			const condition = transition.condition ? { condition: { ...transition.condition } } : {};
			if (transition.lifecycleStatus !== undefined) {
				terminalStatuses.add(transition.lifecycleStatus);
				edges.push({
					from: turnId,
					to: null,
					lifecycleStatus: transition.lifecycleStatus,
					kind: "terminal",
					label,
					...condition,
				});
				continue;
			}
			const next = transition.nextTurnId;
			if (next === undefined) {
				continue;
			}
			const fromIndex = spineIndexByTurn.get(turnId);
			const toIndex = spineIndexByTurn.get(next);
			let kind: ProcessFlowEdge["kind"];
			if (fromIndex !== undefined && toIndex !== undefined) {
				kind = toIndex > fromIndex ? "forward" : "loopback";
			} else {
				kind = "branch";
			}
			edges.push({ from: turnId, to: next, lifecycleStatus: null, kind, label, ...condition });
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
