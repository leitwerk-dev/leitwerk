import {
	type CompactActiveTurnSnapshot,
	emptyCompactTurnSummary,
	type PrimaryPathUiSnapshot,
	type PrimaryPathWsFrame,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";

function updateSemanticLeafRefs(
	snapshot: PrimaryPathUiSnapshot,
	rootEntry: PrimaryPathUiSnapshot["semanticEntryRefs"]["rootEntry"],
	currentLeaf: PrimaryPathUiSnapshot["semanticEntryRefs"]["currentPrimaryPathLeaf"],
): PrimaryPathUiSnapshot {
	return {
		...snapshot,
		currentLeaf,
		semanticEntryRefs: {
			...snapshot.semanticEntryRefs,
			rootEntry,
			currentPrimaryPathLeaf: currentLeaf,
		},
	};
}

function applyMetadataFrame(
	snapshot: PrimaryPathUiSnapshot,
	frame: PrimaryPathWsFrame,
): PrimaryPathUiSnapshot {
	switch (frame.type) {
		case WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED: {
			const next = updateSemanticLeafRefs(
				snapshot,
				frame.payload.rootEntry,
				frame.payload.currentLeaf,
			);
			return {
				...next,
				turnState: {
					...next.turnState,
					currentTurnRecordId: null,
					isStreaming: false,
					activeTurn: null,
				},
			};
		}
		case WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED:
			return {
				...snapshot,
				turnAnnotations: snapshot.turnAnnotations.some(
					(annotation) => annotation.id === frame.payload.annotation.id,
				)
					? snapshot.turnAnnotations.map((annotation) =>
							annotation.id === frame.payload.annotation.id ? frame.payload.annotation : annotation,
						)
					: [...snapshot.turnAnnotations, frame.payload.annotation],
			};
		case WS_PRIMARY_PATH_TYPES.LABEL_CHANGED: {
			if (
				!frame.payload.targetId ||
				!snapshot.primaryPathEntries.some((entry) => entry.id === frame.payload.targetId)
			)
				return snapshot;
			const labels = { ...snapshot.labels };
			if (frame.payload.label) labels[frame.payload.targetId] = frame.payload.label;
			else delete labels[frame.payload.targetId];
			return { ...snapshot, labels };
		}
		case WS_PRIMARY_PATH_TYPES.CHANGED:
			return updateSemanticLeafRefs(snapshot, frame.payload.rootEntry, frame.payload.currentLeaf);
		default:
			return snapshot;
	}
}

export function getPrimaryPathActiveTurnOutput(
	activeTurn: Pick<CompactActiveTurnSnapshot, "assistant"> | null | undefined,
): string {
	return activeTurn?.assistant.text.trim() ?? "";
}

export function applyPrimaryPathFrame(
	snapshot: PrimaryPathUiSnapshot,
	frame: PrimaryPathWsFrame,
): PrimaryPathUiSnapshot {
	if (frame.eventSequence !== undefined && frame.eventSequence <= snapshot.throughEventSequence)
		return snapshot;
	const active = snapshot.turnState.activeTurn;
	if (frame.type === WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED) {
		if (
			!active ||
			active.turnRecordId !== frame.payload.turnRecordId ||
			frame.payload.summary.throughEventSequence <= active.throughEventSequence
		)
			return snapshot;
		return {
			...snapshot,
			throughEventSequence: frame.eventSequence ?? snapshot.throughEventSequence,
			turnState: {
				...snapshot.turnState,
				activeTurn: { ...active, ...frame.payload.summary, summaryPending: false },
			},
		};
	}
	if (frame.type === WS_PRIMARY_PATH_TYPES.TURN_STARTED) {
		const turn = frame.payload.turnRecord;
		return {
			...snapshot,
			throughEventSequence: frame.eventSequence ?? snapshot.throughEventSequence,
			turnState: {
				...snapshot.turnState,
				currentTurnRecordId: turn.id,
				isStreaming: true,
				activeTurn: {
					...emptyCompactTurnSummary(),
					turnRecordId: turn.id,
					turnId: turn.turnId,
					turnType: turn.turnType,
					pathType: turn.pathType,
					startedAt: turn.startedAt,
					summaryPending: true,
				},
			},
		};
	}
	if (
		[
			WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
			WS_PRIMARY_PATH_TYPES.USAGE_UPDATED,
			WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED,
			WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED,
		].includes(frame.type as typeof WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL)
	)
		return snapshot;
	if (
		frame.type === WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED &&
		active &&
		active.turnRecordId !== frame.payload.turnRecord.id
	)
		return snapshot;
	return {
		...applyMetadataFrame(snapshot, frame),
		throughEventSequence: frame.eventSequence ?? snapshot.throughEventSequence,
	};
}
