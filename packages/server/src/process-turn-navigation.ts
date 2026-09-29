import type {
	MappedItem,
	MappedRun,
	ProcessLifecycleStatus,
	ProcessTurnRecord,
} from "@leitwerk-dev/domain";
import type { ProcessGraphView } from "@leitwerk-dev/process-sdk";
import type { ProcessTimelineIteration, ProcessTimelineTurnSummary } from "@leitwerk-dev/protocol";

/** Mapped runs and items of one process, joined for presentation. @internal */
export interface MappedRunPresentation {
	/** @internal */
	runs: readonly MappedRun[];
	/** @internal */
	items: readonly MappedItem[];
}

function iterationFor(
	run: MappedRun,
	item: MappedItem | undefined,
	index: number,
	itemKey: string,
): ProcessTimelineIteration {
	return {
		runId: run.id,
		itemKey,
		index,
		count: run.itemCount,
		label: item?.label ?? itemKey,
	};
}

function withItemLabel(description: string, iteration: ProcessTimelineIteration): string {
	return `${description}: ${iteration.label}`;
}

/** Navigation retains human decisions omitted by the business-flow diagram. */
export function presentProcessTurnNavigation(input: {
	graph: ProcessGraphView;
	turns: readonly ProcessTimelineTurnSummary[];
	selectedTurnId: string | null;
	lifecycleStatus: ProcessLifecycleStatus;
	turnRecords?: readonly Pick<ProcessTurnRecord, "id" | "iteration">[];
	mapped?: MappedRunPresentation;
}): {
	turns: ProcessTimelineTurnSummary[];
	plannedNextTurn: {
		turnId: string;
		description: string;
		iteration?: ProcessTimelineIteration;
	} | null;
} {
	const runs = new Map(input.mapped?.runs.map((run) => [run.id, run]) ?? []);
	const items = new Map(
		input.mapped?.items.map((item) => [`${item.runId}:${item.itemIndex}`, item]) ?? [],
	);
	const iterationsByRecordId = new Map<string, ProcessTimelineIteration>();
	for (const record of input.turnRecords ?? []) {
		const ref = record.iteration;
		const run = ref ? runs.get(ref.runId) : undefined;
		if (!ref || !run) continue;
		iterationsByRecordId.set(
			record.id,
			iterationFor(run, items.get(`${ref.runId}:${ref.itemIndex}`), ref.itemIndex, ref.itemKey),
		);
	}
	const describe = (turnId: string) => input.graph.turns.get(turnId)?.description.trim();

	const activeRun = input.mapped?.runs.find(
		(run) => run.status === "active" && run.turnId === input.selectedTurnId,
	);
	const nextItem =
		input.lifecycleStatus === "active" && activeRun
			? items.get(`${activeRun.id}:${activeRun.nextIndex + 1}`)
			: undefined;
	const path = input.graph.happyPath ?? [];
	const currentIndex = path.indexOf(input.selectedTurnId ?? "");
	const nextId =
		input.lifecycleStatus === "active" && currentIndex >= 0 ? path[currentIndex + 1] : undefined;
	const next = nextId ? input.graph.turns.get(nextId) : undefined;
	let plannedNextTurn: {
		turnId: string;
		description: string;
		iteration?: ProcessTimelineIteration;
	} | null = next && nextId ? { turnId: nextId, description: next.description } : null;
	if (activeRun && nextItem) {
		const iteration = iterationFor(activeRun, nextItem, nextItem.itemIndex, nextItem.itemKey);
		plannedNextTurn = {
			turnId: activeRun.turnId,
			description: withItemLabel(describe(activeRun.turnId) || activeRun.turnId, iteration),
			iteration,
		};
	}

	return {
		turns: input.turns.map((turn) => {
			const displayTurn = describe(turn.turnId) || turn.displayTurn;
			const iteration = iterationsByRecordId.get(turn.id);
			return iteration
				? { ...turn, displayTurn: withItemLabel(displayTurn, iteration), iteration }
				: { ...turn, displayTurn };
		}),
		plannedNextTurn,
	};
}
