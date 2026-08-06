import type {
	ProcessEvent,
	ProcessInstance,
	ProcessSemanticEntryRefKey,
	ProcessSemanticEntryRefs,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
	SemanticEntryRef,
	WorkerLease,
} from "@leitwerk-dev/domain";
import { parseProcessStateJsonLenient } from "@leitwerk-dev/domain";
import { parseStructuralProcessState } from "@leitwerk-dev/process-sdk";
import {
	asWsEventPayloadRecord,
	type PrimaryPathActiveTurnSnapshot,
	type PrimaryPathEntrySnapshot,
	type PrimaryPathSnapshot,
	readWsEventTurnRecordId,
} from "@leitwerk-dev/protocol";
import type { ParsedInstanceTree } from "./instance-tree.js";
import {
	buildLiveTurnProjectionFromEvents,
	snapshotLiveTurnProjection,
} from "./live-turn-projection.js";
import type { ProcessSessionReader } from "./process-session-store.js";

function buildPrimaryPathEntries(input: {
	entriesById: ReadonlyMap<string, PrimaryPathEntrySnapshot>;
	rootEntryId: string | null;
	currentLeafEntryId: string | null;
}): PrimaryPathEntrySnapshot[] {
	const startEntryId = input.currentLeafEntryId ?? input.rootEntryId;
	if (!startEntryId) {
		return [];
	}

	const reversedEntries: PrimaryPathEntrySnapshot[] = [];
	const visited = new Set<string>();
	let currentEntryId: string | null = startEntryId;
	while (currentEntryId) {
		if (visited.has(currentEntryId)) {
			break;
		}
		visited.add(currentEntryId);
		const entry = input.entriesById.get(currentEntryId);
		if (!entry) {
			break;
		}
		reversedEntries.push(entry);
		currentEntryId = entry.parentId;
	}

	const primaryPathEntries = reversedEntries.reverse();
	if (!input.rootEntryId) {
		return primaryPathEntries;
	}

	const rootIndex = primaryPathEntries.findIndex((entry) => entry.id === input.rootEntryId);
	if (rootIndex >= 0) {
		return primaryPathEntries.slice(rootIndex);
	}

	const rootEntry = input.entriesById.get(input.rootEntryId);
	return rootEntry ? [rootEntry] : primaryPathEntries;
}

function getLatestSucceededPrimaryTurnRecord(
	turnRecords: readonly ProcessTurnRecord[],
): ProcessTurnRecord | null {
	for (let index = turnRecords.length - 1; index >= 0; index -= 1) {
		const turnRecord = turnRecords[index];
		if (
			turnRecord?.status === "succeeded" &&
			turnRecord.pathType === "primary" &&
			typeof turnRecord.resultPiEntryId === "string" &&
			turnRecord.resultPiEntryId.trim() !== ""
		) {
			return turnRecord;
		}
	}
	return null;
}

function resolveEntryRefIfPresent(
	entryRef: SemanticEntryRef | null,
	entriesById: ReadonlyMap<string, PrimaryPathEntrySnapshot>,
): SemanticEntryRef | null {
	if (!entryRef) {
		return null;
	}
	return entriesById.has(entryRef.entryId) ? entryRef : null;
}

function deriveRootEntryRef(input: {
	entriesById: ReadonlyMap<string, PrimaryPathEntrySnapshot>;
	currentLeaf: SemanticEntryRef | null;
}): SemanticEntryRef | null {
	if (input.currentLeaf) {
		let currentEntry = input.entriesById.get(input.currentLeaf.entryId);
		const visited = new Set<string>();
		while (currentEntry) {
			if (visited.has(currentEntry.id)) {
				break;
			}
			visited.add(currentEntry.id);
			if (currentEntry.parentId === null) {
				return { entryId: currentEntry.id, turnRecordId: null };
			}
			currentEntry = input.entriesById.get(currentEntry.parentId);
		}
	}

	for (const entry of input.entriesById.values()) {
		if (entry.parentId === null) {
			return { entryId: entry.id, turnRecordId: null };
		}
	}

	return null;
}

function deriveCurrentLeafRef(input: {
	turnRecords: readonly ProcessTurnRecord[];
	entriesById: ReadonlyMap<string, PrimaryPathEntrySnapshot>;
	rootEntry: SemanticEntryRef | null;
}): SemanticEntryRef | null {
	const latestSucceededPrimaryTurnRecord = getLatestSucceededPrimaryTurnRecord(input.turnRecords);
	if (
		latestSucceededPrimaryTurnRecord?.resultPiEntryId &&
		input.entriesById.has(latestSucceededPrimaryTurnRecord.resultPiEntryId)
	) {
		return {
			entryId: latestSucceededPrimaryTurnRecord.resultPiEntryId,
			turnRecordId: latestSucceededPrimaryTurnRecord.id,
		};
	}

	return input.rootEntry;
}

function resolveSemanticEntryRefs(input: {
	semanticEntryRefs: ProcessSemanticEntryRefs;
	turnRecords: readonly ProcessTurnRecord[];
	entriesById: ReadonlyMap<string, PrimaryPathEntrySnapshot>;
}): ProcessSemanticEntryRefs {
	const currentPrimaryPathLeaf =
		resolveEntryRefIfPresent(input.semanticEntryRefs.currentPrimaryPathLeaf, input.entriesById) ??
		null;
	const provisionalRootEntry =
		resolveEntryRefIfPresent(input.semanticEntryRefs.rootEntry, input.entriesById) ?? null;
	const rootEntry =
		provisionalRootEntry ??
		deriveRootEntryRef({
			entriesById: input.entriesById,
			currentLeaf: currentPrimaryPathLeaf,
		});
	const resolvedCurrentPrimaryPathLeaf =
		currentPrimaryPathLeaf ??
		deriveCurrentLeafRef({
			turnRecords: input.turnRecords,
			entriesById: input.entriesById,
			rootEntry,
		});

	return {
		...input.semanticEntryRefs,
		rootEntry,
		currentPrimaryPathLeaf: resolvedCurrentPrimaryPathLeaf,
	};
}

function collectDisplayedSemanticEntryRefKeys(
	semanticEntryRefs: ProcessSemanticEntryRefs,
	displayedEntryIds: ReadonlySet<string>,
): ProcessSemanticEntryRefKey[] {
	return (
		Object.entries(semanticEntryRefs) as Array<
			[ProcessSemanticEntryRefKey, SemanticEntryRef | null]
		>
	)
		.filter(([, ref]) => Boolean(ref?.entryId) && displayedEntryIds.has(ref?.entryId ?? ""))
		.map(([key]) => key as ProcessSemanticEntryRefKey);
}

function collectRelevantTurnRecordIds(input: {
	turnRecords: readonly ProcessTurnRecord[];
	displayedEntryIds: ReadonlySet<string>;
	semanticEntryRefs: ProcessSemanticEntryRefs;
	currentTurnRecordId: string | null;
}): Set<string> {
	const ids = new Set<string>();
	for (const turnRecord of input.turnRecords) {
		if (
			(turnRecord.resultPiEntryId && input.displayedEntryIds.has(turnRecord.resultPiEntryId)) ||
			(turnRecord.forkPiEntryId && input.displayedEntryIds.has(turnRecord.forkPiEntryId))
		) {
			ids.add(turnRecord.id);
		}
	}

	for (const ref of Object.values(input.semanticEntryRefs) as Array<SemanticEntryRef | null>) {
		if (ref?.turnRecordId && input.displayedEntryIds.has(ref.entryId)) {
			ids.add(ref.turnRecordId);
		}
	}

	if (input.currentTurnRecordId) {
		ids.add(input.currentTurnRecordId);
	}

	return ids;
}

function eventPayload(event: ProcessEvent) {
	return asWsEventPayloadRecord(event.data);
}

function eventTurnRecordId(event: ProcessEvent): string | null {
	return readWsEventTurnRecordId(eventPayload(event));
}

function buildActiveTurnSnapshot(input: {
	currentTurnRecordId: string | null;
	turnRecords: readonly ProcessTurnRecord[];
	events: readonly ProcessEvent[];
	eventWindowTruncated: boolean;
}): PrimaryPathActiveTurnSnapshot | null {
	if (!input.currentTurnRecordId) {
		return null;
	}
	const currentTurnRecord = input.turnRecords.find(
		(turnRecord) => turnRecord.id === input.currentTurnRecordId,
	);
	if (!currentTurnRecord || currentTurnRecord.status !== "running") {
		return null;
	}

	const activeTurnEvents = input.events.filter((event) => {
		if (!event.eventType.startsWith("pi.")) {
			return false;
		}
		const correlatedTurnRecordId = eventTurnRecordId(event);
		if (correlatedTurnRecordId) {
			return correlatedTurnRecordId === currentTurnRecord.id;
		}
		return event.createdAt >= currentTurnRecord.startedAt;
	});
	const projection = buildLiveTurnProjectionFromEvents(activeTurnEvents);
	const { assistant, toolCalls, traceItems, usage } = snapshotLiveTurnProjection(projection);

	return {
		turnRecordId: currentTurnRecord.id,
		turnId: currentTurnRecord.turnId,
		turnType: currentTurnRecord.turnType,
		pathType: currentTurnRecord.pathType,
		startedAt: currentTurnRecord.startedAt,
		assistant,
		toolCalls,
		traceItems,
		usage,
		eventWindowTruncated: input.eventWindowTruncated,
	};
}

export interface PrimaryPathSnapshotProjectionInput {
	process: ProcessInstance;
	currentExecutionTurnRecordId?: string | null;
	workerLease: WorkerLease | null;
	turnRecords: readonly ProcessTurnRecord[];
	turnAnnotations: readonly ProcessTurnAnnotation[];
	events: readonly ProcessEvent[];
	eventWindowTruncated?: boolean;
}

export function buildPrimaryPathSnapshotFromTree(
	input: PrimaryPathSnapshotProjectionInput & { tree: ParsedInstanceTree },
): PrimaryPathSnapshot {
	const structuralState = parseStructuralProcessState(
		parseProcessStateJsonLenient(input.process.stateJson),
	);
	const tree = input.tree;
	const semanticEntryRefs = resolveSemanticEntryRefs({
		semanticEntryRefs: structuralState.semanticEntryRefs,
		turnRecords: input.turnRecords,
		entriesById: tree.entriesById,
	});
	const currentLeaf = semanticEntryRefs.currentPrimaryPathLeaf;
	const rootEntry = semanticEntryRefs.rootEntry;
	const primaryPathEntries = buildPrimaryPathEntries({
		entriesById: tree.entriesById,
		rootEntryId: rootEntry?.entryId ?? null,
		currentLeafEntryId: currentLeaf?.entryId ?? null,
	});
	const displayedEntryIds = new Set(primaryPathEntries.map((entry) => entry.id));
	const displayedSemanticEntryRefs = collectDisplayedSemanticEntryRefKeys(
		semanticEntryRefs,
		displayedEntryIds,
	);
	const currentTurnRecordId =
		input.currentExecutionTurnRecordId ??
		(input.process.currentExecution?.kind === "server_turn"
			? input.process.currentExecution.id
			: null);
	const relevantTurnRecordIds = collectRelevantTurnRecordIds({
		turnRecords: input.turnRecords,
		displayedEntryIds,
		semanticEntryRefs,
		currentTurnRecordId,
	});
	const displayedSemanticEntryRefSet = new Set(displayedSemanticEntryRefs);
	const turnAnnotations =
		displayedEntryIds.size === 0 &&
		displayedSemanticEntryRefs.length === 0 &&
		relevantTurnRecordIds.size === 0
			? []
			: input.turnAnnotations.filter((annotation) =>
					annotation.references.some((reference: ProcessTurnAnnotation["references"][number]) => {
						switch (reference.kind) {
							case "entry":
								return displayedEntryIds.has(reference.entryId);
							case "turn_record":
								return relevantTurnRecordIds.has(reference.turnRecordId);
							case "semantic_entry_ref":
								return displayedSemanticEntryRefSet.has(reference.ref);
							default:
								return false;
						}
					}),
				);

	const labels = Object.fromEntries(
		[...tree.labelsByEntryId.entries()].filter(([entryId]) => displayedEntryIds.has(entryId)),
	);

	const activeTurn = buildActiveTurnSnapshot({
		currentTurnRecordId,
		turnRecords: input.turnRecords,
		events: input.events,
		eventWindowTruncated: input.eventWindowTruncated === true,
	});

	return {
		instanceId: input.process.id,
		rebuiltAt: new Date().toISOString(),
		primaryPathEntries,
		currentLeaf,
		semanticEntryRefs,
		labels,
		turnAnnotations,
		detailRail: {
			keyPoints: [],
			futureTurns: [],
			currentPosition: null,
		},
		turnState: {
			currentTurnRecordId,
			workerState: input.workerLease?.state ?? null,
			isStreaming: currentTurnRecordId !== null && input.workerLease?.state === "busy",
			activeTurn,
		},
	};
}

export async function buildPrimaryPathSnapshot(
	input: PrimaryPathSnapshotProjectionInput & { sessionReader: ProcessSessionReader },
): Promise<PrimaryPathSnapshot> {
	const tree = await input.sessionReader.readInstanceTree(input.process.id);
	return buildPrimaryPathSnapshotFromTree({ ...input, tree });
}
