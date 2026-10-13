import {
	humanizeProcessLabel,
	type ProcessFlowEdge,
	type ProcessFlowEndState,
	type ProcessFlowNode,
	type ProcessFlowView,
	type ProcessTurnTerminalLifecycleStatus,
	shortestSuccessfulTurnPath,
	type TurnId,
	trimToNull,
} from "@leitwerk-dev/domain";
import type { ProcessGraphView } from "./process-graph.js";

function deriveSpine(graph: ProcessGraphView, entry: TurnId): TurnId[] {
	return shortestSuccessfulTurnPath(entry, (id) =>
		(graph.turns.get(id)?.transitions ?? []).flatMap((transition) =>
			transition.lifecycleStatus === "completed"
				? [null]
				: transition.nextTurnId !== undefined && graph.turns.has(transition.nextTurnId)
					? [transition.nextTurnId]
					: [],
		),
	);
}

/**
 * Assigns each non-spine turn to the spine node it hangs off. A branch is anchored
 * to the lowest-index spine node that can reach it without passing through another
 * spine node, so offshoots attach to the earliest spine step that launches them.
 */
function deriveBranchAnchors(
	graph: ProcessGraphView,
	spine: readonly TurnId[],
): Map<TurnId, TurnId> {
	const anchorByTurn = new Map<TurnId, TurnId>();
	const spineIds = new Set(spine);
	for (const spineTurnId of spine) {
		const queue = [spineTurnId];
		for (const current of queue) {
			for (const { nextTurnId: next } of graph.turns.get(current)?.transitions ?? []) {
				if (
					next === undefined ||
					!graph.turns.has(next) ||
					spineIds.has(next) ||
					anchorByTurn.has(next)
				)
					continue;
				// Earlier anchors have already explored their non-spine descendants.
				anchorByTurn.set(next, spineTurnId);
				queue.push(next);
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

	const spineIndexByTurn = new Map(spine.map((turnId, index) => [turnId, index]));
	const anchorByTurn = deriveBranchAnchors(graph, spine);
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
			const lifecycleStatus = transition.lifecycleStatus ?? null;
			const next = lifecycleStatus === null ? (transition.nextTurnId ?? null) : null;
			if (lifecycleStatus === null && next === null) continue;
			if (lifecycleStatus !== null) terminalStatuses.add(lifecycleStatus);
			const fromIndex = spineIndexByTurn.get(turnId);
			const toIndex = next === null ? undefined : spineIndexByTurn.get(next);
			edges.push({
				from: turnId,
				to: next,
				lifecycleStatus,
				kind:
					lifecycleStatus !== null
						? "terminal"
						: fromIndex !== undefined && toIndex !== undefined
							? toIndex > fromIndex
								? "forward"
								: "loopback"
							: "branch",
				label: transitionLabel(transition, turn.transitionLabels),
				...(transition.condition ? { condition: { ...transition.condition } } : {}),
			});
		}
	}

	const endStates: ProcessFlowEndState[] = [...new Set([...terminalStatuses, "aborted" as const])]
		.map((lifecycleStatus) => ({
			lifecycleStatus,
			synthetic: !terminalStatuses.has(lifecycleStatus),
		}))
		.sort((left, right) => left.lifecycleStatus.localeCompare(right.lifecycleStatus));

	return {
		processId: graph.id,
		entryTurnIds,
		spine,
		nodes,
		edges,
		endStates,
	};
}
