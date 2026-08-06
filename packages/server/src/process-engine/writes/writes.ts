import {
	type Actor,
	CONTINUE_PROMPT_METADATA_KEY,
	FAILED_TURN_RECOVERY_METADATA_KEY,
	type ProcessInstance,
	SYSTEM_ACTOR,
	type TurnStartRecord,
} from "@leitwerk-dev/domain";
import type { DurableWsFrameInput } from "@leitwerk-dev/protocol";
import type {
	CreatePendingExternalSourceFireInput,
	UpdatePendingExternalSourceFireInput,
} from "../../db/pending-external-source-fire-repo.js";
import type { CreateProcessEventInput } from "../../db/process-event-repo.js";
import type { UpdateProcessInstanceInput } from "../../db/process-instance-repo.js";
import type { CreateProcessLeafOutcomeSnapshotInput } from "../../db/process-leaf-outcome-snapshot-repo.js";
import type { UpdateProcessProjectInput } from "../../db/process-project-repo.js";
import type {
	CreateProcessTurnAnnotationInput,
	UpdateProcessTurnAnnotationInput,
} from "../../db/process-turn-annotation-repo.js";
import type {
	CreateProcessTurnRecordInput,
	UpdateProcessTurnRecordInput,
} from "../../db/process-turn-record-repo.js";
import type { FutureExecutionTransitionPlan } from "../../future-execution/transition-planner.js";
import type { QueuedProcessInput } from "../../process-input-dispatch.js";
import type { DeferredProcessExtensionEvent } from "./deferred-extension-events.js";

export type DurableBroadcast = DurableWsFrameInput;

export type TurnRecordWrite =
	| {
			kind: "create";
			input: CreateProcessTurnRecordInput;
	  }
	| {
			kind: "update";
			id: string;
			input: UpdateProcessTurnRecordInput;
	  };

export type TurnStartWrite =
	| {
			kind: "create";
			input: Omit<TurnStartRecord, "id" | "createdAt" | "updatedAt"> & { id?: string };
	  }
	| {
			kind: "cas_state";
			id: string;
			expectedKind: TurnStartRecord["state"]["kind"];
			state: TurnStartRecord["state"];
	  };

export type TurnAnnotationWrite =
	| {
			kind: "create";
			input: CreateProcessTurnAnnotationInput;
	  }
	| {
			kind: "update";
			id: string;
			input: UpdateProcessTurnAnnotationInput;
	  }
	| {
			kind: "delete";
			id: string;
	  };

export type LeafOutcomeSnapshotWrite = {
	kind: "create";
	input: CreateProcessLeafOutcomeSnapshotInput;
};

export type WorkerIntent =
	| { kind: "reconcile" }
	| { kind: "restart_worker" }
	| { kind: "start_if_needed" }
	| { kind: "abort_turn"; reason: string }
	| { kind: "stop_with_reason"; reason: string };

export type PendingExternalSourceFireWrite =
	| { kind: "create"; input: CreatePendingExternalSourceFireInput }
	| { kind: "update"; id: string; input: UpdatePendingExternalSourceFireInput }
	| { kind: "delete"; id: string };

export interface DecisionMetadata {
	nextTurnModelProfileId?: string | null;
	providerOptions?: Readonly<Record<string, string>>;
}

const METADATA_KEY_GROUPS = {
	retry: ["retryForkPiEntryId", "retryFromTurnRecordId"],
	continuation: [
		"continueFromPiEntryId",
		"continueFromTurnRecordId",
		"continueSavedPrimaryLeafEntryId",
		CONTINUE_PROMPT_METADATA_KEY,
		FAILED_TURN_RECOVERY_METADATA_KEY,
	],
} as const;

export interface Writes {
	processPatch: UpdateProcessInstanceInput;
	changedFields: string[];
	projectWrite?: { id: string; input: UpdateProcessProjectInput };
	turnRecordWrites: TurnRecordWrite[];
	turnStartWrites: TurnStartWrite[];
	turnAnnotationWrites: TurnAnnotationWrite[];
	leafOutcomeSnapshotWrites: LeafOutcomeSnapshotWrite[];
	events: CreateProcessEventInput[];
	broadcasts: DurableBroadcast[];
	queuedInputs: QueuedProcessInput[];
	extensionEvents: DeferredProcessExtensionEvent[];
	futureExecutionPlans: FutureExecutionTransitionPlan[];
	pendingExternalSourceFireWrites: PendingExternalSourceFireWrite[];
	workerIntent?: WorkerIntent;
}

export interface WriteBuildFailure {
	ok: false;
	code: string;
	message: string;
}

export type WriteBuildResult = Writes | WriteBuildFailure;

export function createWrites(init: Partial<Writes> = {}): Writes {
	return {
		processPatch: init.processPatch ?? {},
		changedFields: [...(init.changedFields ?? [])],
		...(init.projectWrite ? { projectWrite: init.projectWrite } : {}),
		turnRecordWrites: [...(init.turnRecordWrites ?? [])],
		turnStartWrites: [...(init.turnStartWrites ?? [])],
		turnAnnotationWrites: [...(init.turnAnnotationWrites ?? [])],
		leafOutcomeSnapshotWrites: [...(init.leafOutcomeSnapshotWrites ?? [])],
		events: [...(init.events ?? [])],
		broadcasts: [...(init.broadcasts ?? [])],
		queuedInputs: [...(init.queuedInputs ?? [])],
		extensionEvents: [...(init.extensionEvents ?? [])],
		futureExecutionPlans: [...(init.futureExecutionPlans ?? [])],
		pendingExternalSourceFireWrites: [...(init.pendingExternalSourceFireWrites ?? [])],
		...(init.workerIntent ? { workerIntent: init.workerIntent } : {}),
	};
}

export function mergeWrites(...writesList: Array<Writes | undefined>): Writes {
	const merged = createWrites();
	for (const writes of writesList) {
		if (!writes) continue;
		Object.assign(merged.processPatch, writes.processPatch);
		for (const field of writes.changedFields) {
			if (!merged.changedFields.includes(field)) {
				merged.changedFields.push(field);
			}
		}
		if (writes.projectWrite) {
			if (merged.projectWrite) throw new Error("Cannot merge multiple process-project writes");
			merged.projectWrite = writes.projectWrite;
		}
		merged.turnRecordWrites.push(...writes.turnRecordWrites);
		merged.turnStartWrites.push(...writes.turnStartWrites);
		merged.turnAnnotationWrites.push(...writes.turnAnnotationWrites);
		merged.leafOutcomeSnapshotWrites.push(...writes.leafOutcomeSnapshotWrites);
		merged.events.push(...writes.events);
		merged.broadcasts.push(...writes.broadcasts);
		merged.queuedInputs.push(...writes.queuedInputs);
		merged.extensionEvents.push(...writes.extensionEvents);
		merged.futureExecutionPlans.push(...writes.futureExecutionPlans);
		merged.pendingExternalSourceFireWrites.push(...writes.pendingExternalSourceFireWrites);
		if (writes.workerIntent) {
			merged.workerIntent = writes.workerIntent;
		}
	}
	return merged;
}

export function isWriteBuildFailure<T>(value: T | WriteBuildFailure): value is WriteBuildFailure {
	return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

export function applyProcessPatchField<K extends keyof UpdateProcessInstanceInput>(
	writes: Writes,
	process: Pick<ProcessInstance, K>,
	field: K,
	value: UpdateProcessInstanceInput[K],
) {
	if (process[field] === value) {
		return;
	}
	writes.processPatch[field] = value;
	if (!writes.changedFields.includes(field as string)) {
		writes.changedFields.push(field as string);
	}
}

export function applyMetadataPatch(
	writes: Writes,
	process: Pick<ProcessInstance, "metadata">,
	nextMetadata: Record<string, unknown> | null,
) {
	if (JSON.stringify(process.metadata ?? null) === JSON.stringify(nextMetadata)) {
		return;
	}
	writes.processPatch.metadata = nextMetadata;
	if (!writes.changedFields.includes("metadata")) {
		writes.changedFields.push("metadata");
	}
}

export function updateProcessMetadata(
	writes: Writes,
	process: Pick<ProcessInstance, "metadata">,
	clearGroups: Array<keyof typeof METADATA_KEY_GROUPS> = [],
	update: (metadata: Record<string, unknown>) => void = () => {},
): void {
	const nextMetadata = process.metadata ? { ...process.metadata } : {};
	for (const group of clearGroups) {
		for (const key of METADATA_KEY_GROUPS[group]) delete nextMetadata[key];
	}
	update(nextMetadata);
	applyMetadataPatch(writes, process, Object.keys(nextMetadata).length > 0 ? nextMetadata : null);
}

export function appendProcessEvent(
	writes: Writes,
	process: Pick<ProcessInstance, "id">,
	input: {
		eventType: string;
		level: string;
		message: string;
		data?: Record<string, unknown>;
	},
): void {
	writes.events.push({
		instanceId: process.id,
		eventType: input.eventType,
		...(input.data ? { data: input.data } : {}),
	});
	writes.broadcasts.push({
		type: "process.event",
		payload: {
			eventType: input.eventType,
			level: input.level,
			message: input.message,
		},
		instanceId: process.id,
	});
}

/**
 * Stamps the acting principal onto the durable `data` blob of every persisted
 * event matching `eventType`. The actor lives only in the persisted event row
 * (not the short `process.event` broadcast summary), consistent with how other
 * event detail is surfaced. Defaults to `SYSTEM_ACTOR` so internal callers are
 * still attributed consistently. Returns the number of events stamped so callers
 * and tests can detect a silent no-op (e.g. when a targeted event type is no
 * longer produced).
 */
export function stampActorOnEvents(
	writes: Writes,
	actor: Actor | undefined,
	eventType: string,
): number {
	const resolvedActor = actor ?? SYSTEM_ACTOR;
	let stamped = 0;
	for (const event of writes.events) {
		if (event.eventType === eventType) {
			event.data = { ...(event.data ?? {}), actor: resolvedActor };
			stamped += 1;
		}
	}
	return stamped;
}

/**
 * Stamps the acting principal onto queued inputs that do not already carry one.
 * Used by action execution so action-originated follow-up prompts inherit the
 * actor that triggered the action.
 */
export function stampActorOnQueuedInputs(writes: Writes, actor: Actor | undefined): void {
	if (!actor) {
		return;
	}
	writes.queuedInputs = writes.queuedInputs.map((queuedInput) =>
		queuedInput.actor ? queuedInput : { ...queuedInput, actor },
	);
}
