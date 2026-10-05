import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { ProcessGraphRegistry, TurnWaitPredicate } from "@leitwerk-dev/process-sdk";
import { generateId } from "../db/repo-helpers.js";
import {
	applyMetadataPatch,
	type DecisionMetadata,
	type TurnStartWrite,
	type Writes,
} from "./writes/writes.js";

const KEY = "turnWait";

/** Durable scheduling state, separate from worker starts and turn attempts. */
export interface PendingTurnWait {
	id: string;
	turnId: string;
	revision: number;
	status: "waiting" | "error";
	nextCheckAt: number;
	failures: number;
	message: string | null;
	start: Extract<TurnStartWrite, { kind: "create" }>["input"];
	metadata?: DecisionMetadata;
	initialSelection?: boolean;
}

export function pendingTurnWait(
	process: Pick<ProcessInstance, "metadata">,
): PendingTurnWait | null {
	const value = process.metadata?.[KEY] as PendingTurnWait | undefined;
	if (!value) return null;
	if (
		typeof value.id !== "string" ||
		typeof value.turnId !== "string" ||
		!Number.isInteger(value.revision) ||
		!Number.isFinite(value.nextCheckAt) ||
		!value.start ||
		value.start.turnId !== value.turnId ||
		(value.status !== "waiting" && value.status !== "error")
	) {
		throw new Error("Invalid persisted turn waiting state");
	}
	return value;
}

export function turnWaitPredicate(
	graphs: ProcessGraphRegistry,
	process: Pick<ProcessInstance, "processId" | "selectedTurnId">,
): TurnWaitPredicate | undefined {
	if (!process.selectedTurnId) return undefined;
	const turn = graphs.get(process.processId)?.turns.get(process.selectedTurnId)?.definition;
	return turn?.kind === "llm" || turn?.kind === "automatic" ? turn.waitFor : undefined;
}

export function writeTurnWait(
	writes: Writes,
	process: ProcessInstance,
	wait: PendingTurnWait | null,
): void {
	const metadata = {
		...((Object.hasOwn(writes.processPatch, "metadata")
			? writes.processPatch.metadata
			: process.metadata) ?? {}),
	};
	if (wait) metadata[KEY] = wait;
	else delete metadata[KEY];
	applyMetadataPatch(writes, process, Object.keys(metadata).length ? metadata : null);
}

/** Every start-producing engine path passes here before a start is persisted. */
export function deferTurnWaitStarts(
	graphs: ProcessGraphRegistry,
	process: ProcessInstance,
	writes: Writes,
	metadata?: DecisionMetadata,
): void {
	const next = { ...process, ...writes.processPatch };
	const previous = pendingTurnWait(process);
	const predicate = turnWaitPredicate(graphs, next);
	const index = writes.turnStartWrites.findIndex(
		(write) => write.kind === "create" && write.input.turnId === next.selectedTurnId,
	);
	const start = index >= 0 ? writes.turnStartWrites[index] : undefined;
	if (!predicate || !start || start.kind !== "create") {
		const currentWait = pendingTurnWait(next);
		if (
			currentWait &&
			(next.selectedTurnId !== currentWait.turnId ||
				next.lifecycleStatus === "completed" ||
				next.lifecycleStatus === "aborted")
		)
			writeTurnWait(writes, process, null);
		return;
	}
	if (writes.waitForAdmission === previous?.id && previous?.turnId === start.input.turnId) return;
	// Subsequent items belong to an already admitted mapped run. Explicit recovery still checks.
	if (start.input.iteration && start.input.startKind === "selected_turn") return;
	writes.turnStartWrites.splice(index, 1);
	const wait: PendingTurnWait =
		previous &&
		previous.turnId === start.input.turnId &&
		start.input.startKind === "selected_turn" &&
		previous.status === "waiting"
			? previous
			: {
					id: generateId("wait"),
					turnId: start.input.turnId,
					revision: 0,
					status: "waiting",
					nextCheckAt: 0,
					failures: 0,
					message: null,
					start: start.input,
					initialSelection:
						process.selectedTurnId === null &&
						process.lifecycleStatus === "discovered" &&
						process.planRevision === 0,
					...(metadata ? { metadata } : {}),
				};
	writeTurnWait(writes, process, wait);
	writes.processPatch.currentExecution = null;
	writes.processPatch.lifecycleStatus = "waiting";
	for (const field of ["currentExecution", "lifecycleStatus"])
		if (!writes.changedFields.includes(field)) writes.changedFields.push(field);
	writes.workerIntent = { kind: "reconcile" };
}
