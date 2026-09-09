import {
	emptyCompactTurnSummary,
	type PrimaryPathActiveTurnSnapshot,
	type PrimaryPathSnapshot,
	type PrimaryPathToolCallSnapshot,
	type PrimaryPathTraceItemSnapshot,
	type PrimaryPathUiSnapshot,
	type PrimaryPathWsFrame,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";
import { cloneTurnUsageSnapshot } from "./usage-snapshot.js";

function cloneToolCalls(toolCalls: readonly PrimaryPathToolCallSnapshot[]) {
	return toolCalls.map((toolCall) => ({
		...toolCall,
		...(toolCall.arguments ? { arguments: { ...toolCall.arguments } } : {}),
	}));
}

function cloneTraceItems(traceItems: readonly PrimaryPathTraceItemSnapshot[]) {
	return traceItems.map((traceItem) => ({ ...traceItem }));
}

function createActiveTurnSnapshot(
	turnRecord: Extract<
		PrimaryPathWsFrame,
		{ type: typeof WS_PRIMARY_PATH_TYPES.TURN_STARTED }
	>["payload"]["turnRecord"],
): PrimaryPathActiveTurnSnapshot {
	return {
		turnRecordId: turnRecord.id,
		turnId: turnRecord.turnId,
		turnType: turnRecord.turnType,
		pathType: turnRecord.pathType,
		startedAt: turnRecord.startedAt,
		assistant: {
			text: "",
			thinking: "",
			lastUpdatedAt: null,
		},
		toolCalls: [],
		traceItems: [],
		usage: null,
		eventWindowTruncated: false,
	};
}

function updateSemanticLeafRefs<TSnapshot extends PrimaryPathSnapshot>(
	snapshot: TSnapshot,
	rootEntry: PrimaryPathSnapshot["semanticEntryRefs"]["rootEntry"],
	currentLeaf: PrimaryPathSnapshot["semanticEntryRefs"]["currentPrimaryPathLeaf"],
): TSnapshot {
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

function upsertToolCall(
	toolCalls: readonly PrimaryPathToolCallSnapshot[],
	nextToolCall: PrimaryPathToolCallSnapshot,
): PrimaryPathToolCallSnapshot[] {
	const existingIndex = toolCalls.findIndex(
		(toolCall) => toolCall.toolCallId === nextToolCall.toolCallId,
	);
	if (existingIndex === -1) {
		return [...toolCalls, nextToolCall];
	}
	return toolCalls.map((toolCall, index) =>
		index === existingIndex
			? {
					...toolCall,
					...nextToolCall,
					arguments: nextToolCall.arguments ?? toolCall.arguments,
				}
			: toolCall,
	);
}

function appendThinkingTraceItems(
	traceItems: readonly PrimaryPathTraceItemSnapshot[],
	text: string,
): PrimaryPathTraceItemSnapshot[] {
	if (text.length === 0) {
		return [...traceItems];
	}
	const lastTraceItem = traceItems.at(-1);
	if (lastTraceItem?.kind === "thinking") {
		return [
			...traceItems.slice(0, -1),
			{
				...lastTraceItem,
				text: lastTraceItem.text + text,
			},
		];
	}
	return [...traceItems, { kind: "thinking", text }];
}

function ensureToolTraceItem(
	traceItems: readonly PrimaryPathTraceItemSnapshot[],
	toolCallId: string,
): PrimaryPathTraceItemSnapshot[] {
	if (
		traceItems.some(
			(traceItem) => traceItem.kind === "tool_call" && traceItem.toolCallId === toolCallId,
		)
	) {
		return [...traceItems];
	}
	return [...traceItems, { kind: "tool_call", toolCallId }];
}

export function getPrimaryPathActiveTurnOutput(
	activeTurn: Pick<PrimaryPathActiveTurnSnapshot, "assistant"> | null | undefined,
): string {
	if (!activeTurn) {
		return "";
	}
	return activeTurn.assistant.text.trim();
}

function applyFullPrimaryPathFrame<TSnapshot extends PrimaryPathSnapshot>(
	snapshot: TSnapshot,
	frame: PrimaryPathWsFrame,
): TSnapshot {
	switch (frame.type) {
		case WS_PRIMARY_PATH_TYPES.TURN_STARTED:
			return {
				...snapshot,
				turnState: {
					...snapshot.turnState,
					currentTurnRecordId: frame.payload.turnRecord.id,
					isStreaming: true,
					activeTurn: createActiveTurnSnapshot(frame.payload.turnRecord),
				},
			};
		case WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL: {
			const activeTurn = snapshot.turnState.activeTurn;
			if (
				!activeTurn ||
				(frame.payload.turnRecordId && activeTurn.turnRecordId !== frame.payload.turnRecordId)
			) {
				return snapshot;
			}
			return {
				...snapshot,
				turnState: {
					...snapshot.turnState,
					isStreaming: true,
					activeTurn: {
						...activeTurn,
						assistant: {
							...activeTurn.assistant,
							text:
								frame.payload.streamType === "thinking"
									? activeTurn.assistant.text
									: activeTurn.assistant.text + frame.payload.text,
							thinking:
								frame.payload.streamType === "thinking"
									? activeTurn.assistant.thinking + frame.payload.text
									: activeTurn.assistant.thinking,
							lastUpdatedAt: frame.payload.timestamp,
						},
						traceItems:
							frame.payload.streamType === "thinking"
								? appendThinkingTraceItems(activeTurn.traceItems, frame.payload.text)
								: cloneTraceItems(activeTurn.traceItems),
					},
				},
			};
		}
		case WS_PRIMARY_PATH_TYPES.USAGE_UPDATED: {
			const activeTurn = snapshot.turnState.activeTurn;
			if (
				!activeTurn ||
				(frame.payload.turnRecordId && activeTurn.turnRecordId !== frame.payload.turnRecordId)
			) {
				return snapshot;
			}
			return {
				...snapshot,
				turnState: {
					...snapshot.turnState,
					activeTurn: {
						...activeTurn,
						usage: cloneTurnUsageSnapshot(frame.payload.usage),
					},
				},
			};
		}
		case WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED: {
			const activeTurn = snapshot.turnState.activeTurn;
			if (
				!activeTurn ||
				(frame.payload.turnRecordId && activeTurn.turnRecordId !== frame.payload.turnRecordId)
			) {
				return snapshot;
			}
			return {
				...snapshot,
				turnState: {
					...snapshot.turnState,
					activeTurn: {
						...activeTurn,
						toolCalls: upsertToolCall(activeTurn.toolCalls, {
							toolCallId: frame.payload.toolCallId,
							toolName: frame.payload.toolName,
							status: "running",
							startedAt: frame.payload.timestamp,
							completedAt: null,
							arguments: frame.payload.arguments,
							result: null,
							isError: false,
						}),
						traceItems: ensureToolTraceItem(activeTurn.traceItems, frame.payload.toolCallId),
					},
				},
			};
		}
		case WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED: {
			const activeTurn = snapshot.turnState.activeTurn;
			if (
				!activeTurn ||
				(frame.payload.turnRecordId && activeTurn.turnRecordId !== frame.payload.turnRecordId)
			) {
				return snapshot;
			}
			const existingToolCall = activeTurn.toolCalls.find(
				(toolCall) => toolCall.toolCallId === frame.payload.toolCallId,
			);
			return {
				...snapshot,
				turnState: {
					...snapshot.turnState,
					activeTurn: {
						...activeTurn,
						toolCalls: upsertToolCall(activeTurn.toolCalls, {
							toolCallId: frame.payload.toolCallId,
							toolName: frame.payload.toolName,
							status: "completed",
							startedAt: existingToolCall?.startedAt ?? frame.payload.timestamp,
							completedAt: frame.payload.timestamp,
							arguments: existingToolCall?.arguments ?? null,
							result: frame.payload.result,
							isError: frame.payload.isError,
						}),
						traceItems: ensureToolTraceItem(activeTurn.traceItems, frame.payload.toolCallId),
					},
				},
			};
		}
		case WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED: {
			const nextSnapshot = updateSemanticLeafRefs(
				snapshot,
				frame.payload.rootEntry,
				frame.payload.currentLeaf,
			);
			return {
				...nextSnapshot,
				turnState: {
					...nextSnapshot.turnState,
					currentTurnRecordId: null,
					isStreaming: false,
					activeTurn: null,
				},
			};
		}
		case WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED: {
			const nextAnnotations = snapshot.turnAnnotations.some(
				(annotation) => annotation.id === frame.payload.annotation.id,
			)
				? snapshot.turnAnnotations.map((annotation) =>
						annotation.id === frame.payload.annotation.id ? frame.payload.annotation : annotation,
					)
				: [...snapshot.turnAnnotations, frame.payload.annotation];
			return {
				...snapshot,
				turnAnnotations: nextAnnotations,
			};
		}
		case WS_PRIMARY_PATH_TYPES.LABEL_CHANGED: {
			if (
				!frame.payload.targetId ||
				!snapshot.primaryPathEntries.some((entry) => entry.id === frame.payload.targetId)
			) {
				return snapshot;
			}
			const nextLabels = { ...snapshot.labels };
			if (frame.payload.label) {
				nextLabels[frame.payload.targetId] = frame.payload.label;
			} else {
				delete nextLabels[frame.payload.targetId];
			}
			return {
				...snapshot,
				labels: nextLabels,
			};
		}
		case WS_PRIMARY_PATH_TYPES.CHANGED:
			return updateSemanticLeafRefs(snapshot, frame.payload.rootEntry, frame.payload.currentLeaf);
		default:
			return snapshot;
	}
}

function cloneFullPrimaryPathSnapshot<TSnapshot extends PrimaryPathSnapshot>(
	snapshot: TSnapshot,
): TSnapshot {
	return {
		...snapshot,
		rebuiltAt: snapshot.rebuiltAt,
		primaryPathEntries: snapshot.primaryPathEntries.map((entry) => ({ ...entry })),
		semanticEntryRefs: { ...snapshot.semanticEntryRefs },
		labels: { ...snapshot.labels },
		turnAnnotations: snapshot.turnAnnotations.map((annotation) => ({
			...annotation,
			references: [...annotation.references],
			payload: { ...annotation.payload },
		})),
		turnState: {
			...snapshot.turnState,
			activeTurn: snapshot.turnState.activeTurn
				? {
						...snapshot.turnState.activeTurn,
						assistant: { ...snapshot.turnState.activeTurn.assistant },
						toolCalls: cloneToolCalls(snapshot.turnState.activeTurn.toolCalls),
						traceItems: cloneTraceItems(snapshot.turnState.activeTurn.traceItems),
						usage: cloneTurnUsageSnapshot(snapshot.turnState.activeTurn.usage),
					}
				: null,
		},
	};
}

export function applyPrimaryPathFrame<T extends PrimaryPathSnapshot | PrimaryPathUiSnapshot>(
	snapshot: T,
	frame: PrimaryPathWsFrame,
): T {
	if (!("entriesOmitted" in snapshot))
		return applyFullPrimaryPathFrame(snapshot as PrimaryPathSnapshot, frame) as T;
	const compact = snapshot as PrimaryPathUiSnapshot;
	if (frame.eventSequence !== undefined && frame.eventSequence <= compact.throughEventSequence)
		return snapshot;
	if (frame.type === WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED) {
		const active = compact.turnState.activeTurn;
		if (
			!active ||
			active.turnRecordId !== frame.payload.turnRecordId ||
			frame.payload.summary.throughEventSequence <= active.throughEventSequence
		)
			return snapshot;
		return {
			...compact,
			throughEventSequence: frame.eventSequence ?? compact.throughEventSequence,
			turnState: {
				...compact.turnState,
				activeTurn: { ...active, ...frame.payload.summary, summaryPending: false },
			},
		} as T;
	}
	if (frame.type === WS_PRIMARY_PATH_TYPES.TURN_STARTED) {
		const turn = frame.payload.turnRecord;
		return {
			...compact,
			throughEventSequence: frame.eventSequence ?? compact.throughEventSequence,
			turnState: {
				...compact.turnState,
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
		} as T;
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
		compact.turnState.activeTurn &&
		compact.turnState.activeTurn.turnRecordId !== frame.payload.turnRecord.id
	)
		return snapshot;
	const metadata = applyFullPrimaryPathFrame(
		{ ...compact, turnState: { ...compact.turnState, activeTurn: null } },
		frame,
	);
	return {
		...metadata,
		throughEventSequence: frame.eventSequence ?? compact.throughEventSequence,
		turnState:
			frame.type === WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED
				? metadata.turnState
				: compact.turnState,
	} as T;
}

export function clonePrimaryPathSnapshot<T extends PrimaryPathSnapshot | PrimaryPathUiSnapshot>(
	snapshot: T,
): T {
	if ("entriesOmitted" in snapshot)
		return {
			...snapshot,
			turnState: {
				...snapshot.turnState,
				activeTurn: snapshot.turnState.activeTurn
					? structuredClone(snapshot.turnState.activeTurn)
					: null,
			},
		};
	return cloneFullPrimaryPathSnapshot(snapshot as PrimaryPathSnapshot) as T;
}
