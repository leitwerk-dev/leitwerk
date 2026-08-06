import {
	type ProcessInput,
	type ProcessInstance,
	type ProcessLeafOutcomeSnapshot,
	type ProcessProject,
	type ProcessTurnAnnotation,
	type ProcessTurnRecord,
	parseProcessStateJsonLenient,
	type SemanticEntryRef,
} from "@leitwerk-dev/domain";
import { parseStructuralProcessState } from "@leitwerk-dev/process-sdk";
import { type DurableWsFrameInput, WS_PRIMARY_PATH_TYPES } from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "../../db/repositories.js";
import {
	buildExtensionEventEffect,
	type PostCommitEffect,
} from "../../effects/post-commit-effect.js";
import { applyRequiredFutureExecutionTransitionPlan } from "../../future-execution/transition-planner.js";
import type { ProcessGraphRegistry } from "../../process-graph.js";
import {
	buildInputQueuedFrames,
	persistQueuedProcessInputs,
	type QueuedProcessInput,
} from "../../process-input-dispatch.js";
import { buildProjectUpdatedEffect } from "../../project-mutation-service.js";
import { selectedTurnRequiresWorker } from "../turn-worker-requirement.js";
import type { DeferredProcessExtensionEvent } from "./deferred-extension-events.js";
import type { WorkerIntent, Writes } from "./writes.js";

export interface RecordWritesDeps
	extends Pick<
		RepositoryBundle,
		| "processes"
		| "events"
		| "inputs"
		| "leafOutcomeSnapshots"
		| "turnRecords"
		| "turnStarts"
		| "turnAnnotations"
		| "futureExecutions"
		| "pendingExternalSourceFires"
		| "projects"
		| "questionRequests"
		| "transaction"
	> {}

export interface RecordCommit {
	instanceId: string;
	processBefore: ProcessInstance | null;
	processAfter: ProcessInstance | null;
	committedProject: ProcessProject | null;
	committedTurnRecords: ProcessTurnRecord[];
	committedLeafOutcomeSnapshots: ProcessLeafOutcomeSnapshot[];
	committedAnnotationChanges: Array<{
		change: "created" | "updated";
		annotation: ProcessTurnAnnotation;
	}>;
	persistedInputs: ProcessInput[];
	extensionEvents: DeferredProcessExtensionEvent[];
	workerIntent?: WorkerIntent;
}

function sameEntryRef(a: SemanticEntryRef | null, b: SemanticEntryRef | null): boolean {
	return (
		(a?.entryId ?? null) === (b?.entryId ?? null) &&
		(a?.turnRecordId ?? null) === (b?.turnRecordId ?? null)
	);
}

function hasPrimaryPathRefChange(
	processBefore: ProcessInstance | null,
	processAfter: ProcessInstance | null,
): boolean {
	if (!processAfter) {
		return false;
	}
	const previousState = parseStructuralProcessState(
		parseProcessStateJsonLenient(processBefore?.stateJson),
	);
	const updatedState = parseStructuralProcessState(
		parseProcessStateJsonLenient(processAfter.stateJson),
	);
	return (
		!sameEntryRef(
			previousState.semanticEntryRefs.rootEntry,
			updatedState.semanticEntryRefs.rootEntry,
		) ||
		!sameEntryRef(
			previousState.semanticEntryRefs.currentPrimaryPathLeaf,
			updatedState.semanticEntryRefs.currentPrimaryPathLeaf,
		)
	);
}

function getPrimaryPathRefs(process: ProcessInstance | null) {
	const structuralState = parseStructuralProcessState(
		parseProcessStateJsonLenient(process?.stateJson),
	);
	return {
		rootEntry: structuralState.semanticEntryRefs.rootEntry,
		currentLeaf: structuralState.semanticEntryRefs.currentPrimaryPathLeaf,
	};
}

function buildPrimaryPathFrames(input: {
	instanceId: string;
	processBefore: ProcessInstance | null;
	processAfter: ProcessInstance | null;
	committedTurnRecords: readonly ProcessTurnRecord[];
	committedAnnotationChanges: ReadonlyArray<{
		change: "created" | "updated";
		annotation: ProcessTurnAnnotation;
	}>;
}): DurableWsFrameInput[] {
	const frames: DurableWsFrameInput[] = [];
	const refs = getPrimaryPathRefs(input.processAfter);
	let emittedPrimaryAssistantCommit = false;

	for (const turnRecord of input.committedTurnRecords) {
		if (turnRecord.status === "running") {
			frames.push({
				type: WS_PRIMARY_PATH_TYPES.TURN_STARTED,
				payload: { turnRecord },
				instanceId: input.instanceId,
			});
			continue;
		}
		if (
			turnRecord.status === "succeeded" &&
			turnRecord.turnType === "llm" &&
			turnRecord.resultPiEntryId
		) {
			if (turnRecord.pathType === "primary") {
				emittedPrimaryAssistantCommit = true;
			}
			frames.push({
				type: WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED,
				payload: {
					turnRecord,
					rootEntry: refs.rootEntry,
					currentLeaf: refs.currentLeaf,
				},
				instanceId: input.instanceId,
			});
		}
	}

	for (const change of input.committedAnnotationChanges) {
		frames.push({
			type: WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED,
			payload: change,
			instanceId: input.instanceId,
		});
	}

	if (
		hasPrimaryPathRefChange(input.processBefore, input.processAfter) &&
		!emittedPrimaryAssistantCommit
	) {
		frames.push({
			type: WS_PRIMARY_PATH_TYPES.CHANGED,
			payload: {
				rootEntry: refs.rootEntry,
				currentLeaf: refs.currentLeaf,
			},
			instanceId: input.instanceId,
		});
	}
	return frames;
}

export function commitWrites(
	deps: RecordWritesDeps,
	instanceId: string,
	writes: Writes,
): RecordCommit {
	return deps.transaction((repos) => {
		const processBefore = repos.processes.getById(instanceId);
		const committedTurnRecords: ProcessTurnRecord[] = [];
		for (const write of writes.turnStartWrites) {
			if (write.kind === "create") repos.turnStarts.create(write.input);
			else if (!repos.turnStarts.compareAndSetState(write)) {
				throw new Error(`Turn start '${write.id}' changed before acceptance`);
			}
		}
		const committedLeafOutcomeSnapshots: ProcessLeafOutcomeSnapshot[] = [];
		const committedAnnotationChanges: Array<{
			change: "created" | "updated";
			annotation: ProcessTurnAnnotation;
		}> = [];

		for (const write of writes.turnRecordWrites) {
			const committedTurnRecord =
				write.kind === "create"
					? repos.turnRecords.create(write.input)
					: repos.turnRecords.update(write.id, write.input);
			if (committedTurnRecord) {
				committedTurnRecords.push(committedTurnRecord);
				if (committedTurnRecord.status !== "running") {
					repos.questionRequests.cancelOpenByTurn(instanceId, committedTurnRecord.id);
				}
			}
		}

		for (const write of writes.turnAnnotationWrites) {
			if (write.kind === "create") {
				committedAnnotationChanges.push({
					change: "created",
					annotation: repos.turnAnnotations.create(write.input),
				});
				continue;
			}
			if (write.kind === "update") {
				const annotation = repos.turnAnnotations.update(write.id, write.input);
				if (annotation) {
					committedAnnotationChanges.push({
						change: "updated",
						annotation,
					});
				}
				continue;
			}
			repos.turnAnnotations.delete(write.id);
		}

		for (const write of writes.leafOutcomeSnapshotWrites) {
			committedLeafOutcomeSnapshots.push(repos.leafOutcomeSnapshots.create(write.input));
		}

		const processAfter =
			writes.changedFields.length > 0
				? repos.processes.update(instanceId, writes.processPatch)
				: repos.processes.getById(instanceId);
		const committedProject = writes.projectWrite
			? repos.projects.update(writes.projectWrite.id, writes.projectWrite.input)
			: null;
		if (writes.projectWrite && !committedProject) {
			throw new Error(`Process project '${writes.projectWrite.id}' disappeared during commit`);
		}
		if (committedProject && committedProject.instanceId !== instanceId) {
			throw new Error(
				`Process project '${committedProject.id}' does not belong to '${instanceId}'`,
			);
		}

		for (const write of writes.pendingExternalSourceFireWrites) {
			if (write.kind === "create") {
				repos.pendingExternalSourceFires.create(write.input);
				continue;
			}
			if (write.kind === "update") {
				repos.pendingExternalSourceFires.update(write.id, write.input);
				continue;
			}
			repos.pendingExternalSourceFires.delete(write.id);
		}

		for (const event of writes.events) {
			repos.events.create(event);
		}
		for (const plan of writes.futureExecutionPlans) {
			applyRequiredFutureExecutionTransitionPlan(repos.futureExecutions, plan);
		}

		const persistedInputs = persistQueuedProcessInputs(
			repos.inputs,
			instanceId,
			writes.queuedInputs as QueuedProcessInput[],
		);

		return {
			instanceId,
			processBefore,
			processAfter,
			committedProject,
			committedTurnRecords,
			committedLeafOutcomeSnapshots,
			committedAnnotationChanges,
			persistedInputs,
			extensionEvents: [...writes.extensionEvents],
			...(writes.workerIntent ? { workerIntent: writes.workerIntent } : {}),
		};
	});
}

export function deriveReactions(
	commit: RecordCommit,
	writes: Writes,
	options: { processGraphs?: ProcessGraphRegistry } = {},
): PostCommitEffect[] {
	const effects: PostCommitEffect[] = [];
	let processUpdatedExtensionEffect: PostCommitEffect | null = null;
	for (const frame of writes.broadcasts) {
		effects.push({ kind: "broadcast", frame });
	}
	if (commit.committedProject) effects.push(buildProjectUpdatedEffect(commit.committedProject));
	if (writes.changedFields.length > 0) {
		const includeClosedAt =
			commit.processAfter !== null &&
			(commit.processBefore?.closedAt ?? null) !== (commit.processAfter.closedAt ?? null);
		const processPatch = {
			...writes.processPatch,
			...(commit.processAfter?.updatedAt ? { updatedAt: commit.processAfter.updatedAt } : {}),
			...(includeClosedAt ? { closedAt: commit.processAfter?.closedAt ?? null } : {}),
		};
		let changedFields =
			commit.processAfter?.updatedAt && !writes.changedFields.includes("updatedAt")
				? [...writes.changedFields, "updatedAt"]
				: writes.changedFields;
		if (includeClosedAt && !changedFields.includes("closedAt")) {
			changedFields = [...changedFields, "closedAt"];
		}
		effects.push({
			kind: "broadcast",
			frame: {
				type: "process.updated",
				payload: {
					process: processPatch,
					changedFields,
				},
				instanceId: commit.instanceId,
			},
		});
		if (commit.processAfter) {
			processUpdatedExtensionEffect = buildExtensionEventEffect(
				commit.instanceId,
				"process_updated",
				{
					process: commit.processAfter,
					changedFields,
				},
			);
		}
	}
	for (const frame of buildPrimaryPathFrames(commit)) {
		effects.push({ kind: "broadcast", frame });
	}
	for (const turnRecord of commit.committedTurnRecords) {
		if (turnRecord.status === "running") {
			effects.push(buildExtensionEventEffect(commit.instanceId, "turn_started", { turnRecord }));
		}
		if (turnRecord.status === "failed") {
			effects.push(
				buildExtensionEventEffect(commit.instanceId, "turn_failed", {
					turnRecord,
					errorSummary: turnRecord.errorSummary ?? "Turn failed",
					errorClass: turnRecord.errorClass,
				}),
			);
		}
	}
	for (const snapshot of commit.committedLeafOutcomeSnapshots) {
		effects.push(
			buildExtensionEventEffect(commit.instanceId, "leaf_outcome_captured", { snapshot }),
		);
	}
	if (processUpdatedExtensionEffect) {
		effects.push(processUpdatedExtensionEffect);
	}
	for (const frame of buildInputQueuedFrames(commit.instanceId, commit.persistedInputs)) {
		effects.push({ kind: "broadcast", frame });
	}
	if (commit.workerIntent && commit.workerIntent.kind !== "reconcile") {
		effects.push({ kind: "worker", instanceId: commit.instanceId, effect: commit.workerIntent });
	}
	if (commit.persistedInputs.length > 0) {
		effects.push({
			kind: "dispatch_inputs",
			instanceId: commit.instanceId,
			inputs: commit.persistedInputs,
			spawnIfMissing: commit.processAfter
				? selectedTurnRequiresWorker(options.processGraphs, commit.processAfter)
				: false,
		});
	}
	for (const event of commit.extensionEvents) {
		effects.push({ kind: "extension_event", event });
	}
	return effects;
}
