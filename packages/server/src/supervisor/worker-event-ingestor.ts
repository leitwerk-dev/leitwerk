import {
	asWsEventPayloadRecord,
	createDurableWsFrame,
	createEphemeralWsFrame,
	isStreamableEvent,
	mapWorkerEventToWsType,
	readWsEventNonEmptyString,
	readWsEventPiTurnId,
	readWsEventStreamText,
	readWsEventTimestamp,
	readWsEventToolArguments,
	readWsEventToolName,
	WS_PRIMARY_PATH_TYPES,
} from "@leitwerk-dev/protocol";
import type { WorkerEventPayload } from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import {
	applyPiEventToLiveTurnProjection,
	buildLiveTurnProjectionFromEvents,
	createMutableLiveTurnProjection,
	type MutableLiveTurnProjection,
} from "../live-turn-projection.js";
import { recordTurnPreparation } from "../turn-preparation.js";
import { recordTurnProgress } from "../turn-progress.js";
import type { Broadcaster } from "../ws/broadcast.js";
import { recordInitialTurnObservation } from "./startup-observer.js";

export interface WorkerEventLogEntry {
	instanceId: string;
	workerId: string;
	eventType: string;
	selectedTurnId: string | null;
	timestamp: string;
	serverObservedAt: string;
	serverObservedLatencyMs: number | null;
	turnRecordId: string | null;
	data: Record<string, unknown>;
}

export interface WorkerEventIngestorDeps
	extends Pick<RepositoryBundle, "processes" | "events" | "turnRecords"> {
	leases?: RepositoryBundle["leases"];
	startupObservations?: RepositoryBundle["startupObservations"];
	broadcaster: Broadcaster;
	workerEventLogger?: (entry: WorkerEventLogEntry) => void;
}

function eventTimestamp(data: Record<string, unknown>): string {
	return readWsEventTimestamp(data, new Date().toISOString());
}

function eventObservationLatencyMs(eventTimestamp: string, observedAt: string): number | null {
	const eventMs = Date.parse(eventTimestamp);
	const observedMs = Date.parse(observedAt);
	if (!Number.isFinite(eventMs) || !Number.isFinite(observedMs)) {
		return null;
	}
	return Math.max(0, observedMs - eventMs);
}

function hydrateLiveTurnProjection(
	deps: Pick<WorkerEventIngestorDeps, "events" | "turnRecords">,
	instanceId: string,
	turnRecordId: string | null,
): MutableLiveTurnProjection {
	if (!turnRecordId) {
		return createMutableLiveTurnProjection();
	}
	const turnRecord = deps.turnRecords.getById(turnRecordId);
	if (!turnRecord) {
		return createMutableLiveTurnProjection();
	}
	return buildLiveTurnProjectionFromEvents(deps.events.listByTurnRecord(instanceId, turnRecordId));
}

export function createWorkerEventIngestor(deps: WorkerEventIngestorDeps) {
	const liveTurnRecordIds = new Map<string, string>();
	const liveTurnProjections = new Map<
		string,
		{ turnRecordId: string | null; projection: MutableLiveTurnProjection }
	>();

	function getLiveTurnProjection(
		instanceId: string,
		turnRecordId: string | null,
	): MutableLiveTurnProjection {
		const existing = liveTurnProjections.get(instanceId);
		if (existing && existing.turnRecordId === turnRecordId) {
			return existing.projection;
		}
		const projection = hydrateLiveTurnProjection(deps, instanceId, turnRecordId);
		liveTurnProjections.set(instanceId, { turnRecordId, projection });
		return projection;
	}

	function setLiveTurnProjection(instanceId: string, turnRecordId: string | null) {
		liveTurnProjections.set(instanceId, {
			turnRecordId,
			projection: createMutableLiveTurnProjection(),
		});
	}

	return {
		getLiveTurnRecordId(instanceId: string): string | null {
			return liveTurnRecordIds.get(instanceId) ?? null;
		},
		noteTurnStarted(instanceId: string, turnRecordId: string): void {
			liveTurnRecordIds.set(instanceId, turnRecordId);
			setLiveTurnProjection(instanceId, turnRecordId);
		},
		clearLiveTurnState(instanceId: string): void {
			liveTurnRecordIds.delete(instanceId);
			liveTurnProjections.delete(instanceId);
		},
		ingestWorkerEvent(input: {
			instanceId: string;
			workerId: string;
			payload: WorkerEventPayload;
		}): void {
			const { instanceId, workerId, payload } = input;
			const process = deps.processes.getById(instanceId);
			if (!process) {
				return;
			}
			const currentTurnRecordId =
				liveTurnRecordIds.get(instanceId) ??
				deps.turnRecords
					.listByInstance(instanceId)
					.find((record) => record.status === "running" && record.turnId === process.selectedTurnId)
					?.id ??
				null;
			const data = asWsEventPayloadRecord(payload.data);
			const suppliedTurnRecordId = readWsEventNonEmptyString(data.turnRecordId);
			const milestone =
				payload.eventType === "worker.trace" && data.code === "turn.prompt_started"
					? "prompt_started"
					: payload.eventType === "pi.stream.delta" &&
							data.streamType === "text" &&
							(readWsEventStreamText(data)?.length ?? 0) > 0
						? "first_text"
						: null;
			if (
				milestone &&
				suppliedTurnRecordId &&
				suppliedTurnRecordId === currentTurnRecordId &&
				deps.leases
			)
				recordInitialTurnObservation(
					{ ...deps, leases: deps.leases },
					{
						instanceId,
						workerId,
						turnRecordId: suppliedTurnRecordId,
						milestone,
						observedAt: new Date().toISOString(),
					},
				);
			if (suppliedTurnRecordId && suppliedTurnRecordId !== currentTurnRecordId) return;
			if (payload.eventType === "turn.progress") {
				const reportedTurnRecordId = readWsEventNonEmptyString(data.turnRecordId);
				if (!reportedTurnRecordId || reportedTurnRecordId !== currentTurnRecordId) return;
				recordTurnProgress(deps, {
					instanceId,
					turnRecordId: reportedTurnRecordId,
					report: data.report,
				});
				return;
			}
			if (payload.eventType === "turn.prepared") {
				const reportedTurnRecordId = readWsEventNonEmptyString(data.turnRecordId);
				if (!reportedTurnRecordId || reportedTurnRecordId !== currentTurnRecordId) return;
				recordTurnPreparation(deps, {
					instanceId,
					turnRecordId: reportedTurnRecordId,
					data: data.data,
				});
				return;
			}
			const projection = getLiveTurnProjection(instanceId, currentTurnRecordId);
			const appliedProjectionEvent = applyPiEventToLiveTurnProjection(projection, {
				eventType: payload.eventType,
				data,
				fallbackTimestamp: new Date().toISOString(),
			});
			const projectionData = appliedProjectionEvent.canonicalData;
			const enrichedData: Record<string, unknown> =
				currentTurnRecordId && !readWsEventNonEmptyString(projectionData.turnRecordId)
					? { ...projectionData, turnRecordId: currentTurnRecordId }
					: projectionData;
			const currentSelectedTurnId = payload.selectedTurnId ?? process.selectedTurnId ?? null;
			const normalizedTimestamp = eventTimestamp(enrichedData);
			const serverObservedAt = new Date().toISOString();
			const serverObservedLatencyMs = eventObservationLatencyMs(
				normalizedTimestamp,
				serverObservedAt,
			);
			const eventTurnRecordId = readWsEventNonEmptyString(enrichedData.turnRecordId);
			const persistedEvent = deps.events.create({
				instanceId,
				eventType: payload.eventType,
				data: enrichedData,
			});

			try {
				deps.workerEventLogger?.({
					instanceId,
					workerId,
					eventType: payload.eventType,
					selectedTurnId: currentSelectedTurnId,
					timestamp: normalizedTimestamp,
					serverObservedAt,
					serverObservedLatencyMs,
					turnRecordId: eventTurnRecordId,
					data: enrichedData,
				});
			} catch {
				// Debug mirroring must never interfere with the durable worker-event path.
			}
			if (isStreamableEvent(payload.eventType)) {
				const wsType = mapWorkerEventToWsType(payload.eventType);
				if (wsType) {
					deps.broadcaster.broadcast(
						createEphemeralWsFrame({
							type: wsType,
							eventSequence: persistedEvent.eventSequence,
							payload: enrichedData,
							instanceId,
						}),
					);
				}
			}
			if (payload.eventType === "pi.stream.delta") {
				const text = readWsEventStreamText(enrichedData);
				if (text) {
					deps.broadcaster.broadcast(
						createEphemeralWsFrame({
							type: WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
							eventSequence: persistedEvent.eventSequence,
							payload: {
								turnRecordId: currentTurnRecordId,
								piTurnId: readWsEventPiTurnId(enrichedData),
								text,
								streamType: readWsEventNonEmptyString(enrichedData.streamType) ?? "text",
								timestamp: normalizedTimestamp,
							},
							instanceId,
						}),
					);
				}
			} else if (payload.eventType === "pi.usage") {
				const usage = projection.usage;
				if (usage) {
					deps.broadcaster.broadcast(
						createEphemeralWsFrame({
							type: WS_PRIMARY_PATH_TYPES.USAGE_UPDATED,
							eventSequence: persistedEvent.eventSequence,
							payload: {
								turnRecordId: currentTurnRecordId,
								piTurnId: readWsEventPiTurnId(enrichedData),
								usage,
								timestamp: normalizedTimestamp,
							},
							instanceId,
						}),
					);
				}
			} else if (payload.eventType === "pi.tool.call") {
				deps.broadcaster.broadcast(
					createEphemeralWsFrame({
						type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED,
						eventSequence: persistedEvent.eventSequence,
						payload: {
							turnRecordId: currentTurnRecordId,
							piTurnId: readWsEventPiTurnId(enrichedData),
							toolCallId: appliedProjectionEvent.toolCallId ?? "tool",
							toolName: appliedProjectionEvent.toolName ?? readWsEventToolName(enrichedData),
							arguments: readWsEventToolArguments(enrichedData),
							timestamp: normalizedTimestamp,
						},
						instanceId,
					}),
				);
			} else if (payload.eventType === "pi.tool.result") {
				deps.broadcaster.broadcast(
					createEphemeralWsFrame({
						type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED,
						eventSequence: persistedEvent.eventSequence,
						payload: {
							turnRecordId: currentTurnRecordId,
							piTurnId: readWsEventPiTurnId(enrichedData),
							toolCallId: appliedProjectionEvent.toolCallId ?? "tool",
							toolName: appliedProjectionEvent.toolName ?? readWsEventToolName(enrichedData),
							result: enrichedData.result ?? null,
							isError: enrichedData.isError === true,
							timestamp: normalizedTimestamp,
						},
						instanceId,
					}),
				);
			} else if (payload.eventType === "pi.label.changed") {
				deps.broadcaster.broadcast(
					createDurableWsFrame({
						type: WS_PRIMARY_PATH_TYPES.LABEL_CHANGED,
						eventSequence: persistedEvent.eventSequence,
						payload: {
							turnRecordId: currentTurnRecordId,
							piTurnId: readWsEventPiTurnId(enrichedData),
							targetId: readWsEventNonEmptyString(enrichedData.targetId),
							label: typeof enrichedData.label === "string" ? enrichedData.label : null,
							timestamp: normalizedTimestamp,
						},
						instanceId,
					}),
				);
			}
			if (eventTurnRecordId) {
				const summary = deps.events.summary(eventTurnRecordId);
				if (summary)
					deps.broadcaster.broadcast(
						createEphemeralWsFrame({
							type: WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED,
							instanceId,
							eventSequence: persistedEvent.eventSequence,
							payload: { turnRecordId: eventTurnRecordId, summary },
						}),
					);
			}
		},
	};
}
