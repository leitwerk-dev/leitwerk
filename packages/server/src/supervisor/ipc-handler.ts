import { isWorkerErrorClass } from "@leitwerk-dev/domain";
import { createDurableWsFrame } from "@leitwerk-dev/protocol";
import {
	decodeWorkerToServerMessage,
	type IpcEnvelope,
	type WorkerCredentialUpdateResultPayload,
	type WorkerIntegrationToolCancelPayload,
	type WorkerIntegrationToolRequestPayload,
	type WorkerIntegrationToolResultPayload,
	type WorkerTurnFailedPayload,
	type WorkerTurnStartAcceptedPayload,
} from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import type { WorkerLeaseObservation } from "../domain-logic/worker-lease-lifecycle.js";
import type { LaunchCoordinator } from "../launch-coordinator.js";
import type { ProcessEngine } from "../process-engine/types.js";
import type { ProcessQuestionService } from "../process-question-service.js";
import type { Broadcaster } from "../ws/broadcast.js";
import { createWorkerEventIngestor, type WorkerEventLogEntry } from "./worker-event-ingestor.js";
import { createWorkerInputAckHandler } from "./worker-input-ack-handler.js";
import { applyWorkerLeaseObservation, resolveActiveWorkerLease } from "./worker-lease-observer.js";
import { createWorkerTurnIpcRecorder } from "./worker-turn-ipc-recorder.js";

export type { WorkerEventLogEntry } from "./worker-event-ingestor.js";
export type { IpcEnvelope };

function mapWorkerStateToObservation(value: string): WorkerLeaseObservation | null {
	switch (value) {
		case "busy":
			return "busy_reported";
		case "idle":
			return "idle_reported";
		case "draining":
			return "stop_requested";
		default:
			return null;
	}
}

export interface IpcHandlerDeps
	extends Pick<
		RepositoryBundle,
		"processes" | "projects" | "inputs" | "events" | "leases" | "turnRecords"
	> {
	getLaunchCoordinator?: () => LaunchCoordinator | undefined;
	processQuestions?: ProcessQuestionService;
	broadcaster: Broadcaster;
	commands: ProcessEngine;
	workerEventLogger?: (entry: WorkerEventLogEntry) => void;
	appendDiagnosticTrace?: (instanceId: string, text: string) => void;
	updateCredential?: (input: {
		providerId: string;
		expectedRevision: number;
		values: Record<string, string>;
	}) => { accepted: boolean; currentRevision: number | null; safeReason?: string };
	handleIntegrationToolRequest?: (
		instanceId: string,
		payload: WorkerIntegrationToolRequestPayload,
	) => Promise<WorkerIntegrationToolResultPayload>;
	handleIntegrationToolCancel?: (
		instanceId: string,
		payload: WorkerIntegrationToolCancelPayload,
	) => void;
}

export interface IpcHandlerCallbacks {
	onWorkerReady?: (instanceId: string, workerId: string) => void;
	onWorkerFailed?: (instanceId: string, workerId: string, error: string) => void;
	onWorkerExited?: (instanceId: string, workerId: string) => void;
	onTurnOutcomeRecorded?: (
		instanceId: string,
		turnId: string,
		outcome: string,
		params: Record<string, unknown>,
	) => void;
	onTurnTerminalRecorded?: (instanceId: string, workerId: string, turnRecordId: string) => void;
	onTurnFailedRecorded?: (input: {
		instanceId: string;
		workerId: string;
		turnRecordId: string;
		turnId: string;
		turnType: WorkerTurnFailedPayload["turnType"];
		errorSummary: string;
		errorClass?: WorkerTurnFailedPayload["errorClass"];
		failureCode?: WorkerTurnFailedPayload["failureCode"];
	}) => void;
	onTurnTerminalRecordingFailed?: (input: {
		instanceId: string;
		workerId: string;
		turnRecordId: string;
		terminalType: "outcome" | "failure";
		code: string;
		message: string;
	}) => void;
	onCleanupCompleted?: (instanceId: string, workerId: string) => void;
	onWorkerTurnStartAccepted?: (
		instanceId: string,
		workerId: string,
		payload: WorkerTurnStartAcceptedPayload,
	) => void;
	onCredentialUpdateResult?: (
		instanceId: string,
		workerId: string,
		payload: WorkerCredentialUpdateResultPayload,
	) => void;
	onIntegrationToolResult?: (
		instanceId: string,
		workerId: string,
		payload: WorkerIntegrationToolResultPayload,
	) => void;
}

export function createIpcHandler(deps: IpcHandlerDeps, callbacks: IpcHandlerCallbacks) {
	const eventIngestor = createWorkerEventIngestor(deps);
	const inputAckHandler = createWorkerInputAckHandler(deps);
	const turnRecorder = createWorkerTurnIpcRecorder(
		{
			processes: deps.processes,
			turnRecords: deps.turnRecords,
			commands: deps.commands,
			eventIngestor,
		},
		{
			onTurnOutcomeRecorded: callbacks.onTurnOutcomeRecorded,
			onTurnTerminalRecorded: callbacks.onTurnTerminalRecorded,
			onTurnFailedRecorded: callbacks.onTurnFailedRecorded,
			onTurnTerminalRecordingFailed: callbacks.onTurnTerminalRecordingFailed,
		},
	);

	return {
		handleMessage(envelope: IpcEnvelope): void {
			const decoded = decodeWorkerToServerMessage(envelope);
			if (!decoded.ok) {
				return;
			}
			const msg = decoded.message;
			const instanceId = msg.instanceId;
			const workerId = msg.workerId;
			const activeLease = resolveActiveWorkerLease(deps.leases, instanceId, workerId);
			if (!activeLease) {
				return;
			}
			const launchCoordinator = deps.getLaunchCoordinator?.();
			const observeWorkerLease = (observation: WorkerLeaseObservation, reason?: string) =>
				applyWorkerLeaseObservation(
					{ leases: deps.leases, broadcaster: deps.broadcaster },
					{ instanceId, workerId, observation, reason },
				);

			switch (msg.type) {
				case "worker.integration_tool_cancel": {
					deps.handleIntegrationToolCancel?.(instanceId, msg.payload);
					break;
				}
				case "worker.integration_tool_request": {
					if (!deps.handleIntegrationToolRequest) break;
					void deps
						.handleIntegrationToolRequest(instanceId, msg.payload)
						.then((payload) => callbacks.onIntegrationToolResult?.(instanceId, workerId, payload))
						.catch(() =>
							callbacks.onIntegrationToolResult?.(instanceId, workerId, {
								turnRecordId: msg.payload.turnRecordId,
								toolCallId: msg.payload.toolCallId,
								ok: false,
								error: "Integration tool execution failed",
							}),
						);
					break;
				}
				case "worker.credential_update": {
					const result = deps.updateCredential?.(msg.payload) ?? {
						accepted: false,
						currentRevision: null,
						safeReason: "Credential updates are unavailable",
					};
					callbacks.onCredentialUpdateResult?.(instanceId, workerId, {
						providerId: msg.payload.providerId,
						accepted: result.accepted,
						currentRevision: result.currentRevision,
						...(result.safeReason ? { safeReason: result.safeReason } : {}),
					});
					break;
				}
				case "worker.hello": {
					observeWorkerLease("handshake_received", "worker.hello");
					deps.leases.observeTimestamp(activeLease.id, "connectedAt");
					break;
				}
				case "worker.diagnostic_trace": {
					deps.appendDiagnosticTrace?.(instanceId, msg.payload.text);
					break;
				}
				case "worker.bootstrap_progress": {
					if (
						msg.payload.phase === "preparing_workspace" ||
						msg.payload.phase === "loading_resources"
					) {
						deps.leases.observeTimestamp(activeLease.id, "workspacePreparationStartedAt");
					}
					launchCoordinator?.observeBootstrapProgress(instanceId, workerId, msg.payload.phase);
					break;
				}
				case "worker.ready": {
					if (!msg.payload.receipt) {
						callbacks.onWorkerFailed?.(instanceId, workerId, "Worker bootstrap receipt is missing");
						break;
					}
					if (
						msg.payload.receipt.workerLeaseId !== activeLease.id ||
						msg.payload.receipt.startRecordId !==
							(deps.processes.getById(instanceId)?.currentExecution?.kind === "worker_start"
								? deps.processes.getById(instanceId)?.currentExecution?.id
								: null)
					) {
						callbacks.onWorkerFailed?.(instanceId, workerId, "Worker bootstrap receipt is stale");
						break;
					}
					const receiptWrite = deps.leases.compareAndSetBootstrapReceipt(
						activeLease.id,
						msg.payload.receipt,
					);
					if (receiptWrite === "changed") {
						callbacks.onWorkerFailed?.(instanceId, workerId, "Worker bootstrap receipt changed");
						break;
					}
					const result = observeWorkerLease("bootstrap_completed", "worker.ready");
					if (result.kind === "applied") {
						deps.leases.observeTimestamp(activeLease.id, "readyAt");
						launchCoordinator?.observeWorkerReady(instanceId, workerId);
						deps.leases.updateHeartbeat(activeLease.workerId);
						void deps.commands
							.updateSemanticEntryRefs(instanceId, {
								rootEntry:
									msg.payload.rootEntryId !== undefined
										? msg.payload.rootEntryId
											? { entryId: msg.payload.rootEntryId, turnRecordId: null }
											: null
										: undefined,
							})
							.catch(() => {});
						callbacks.onWorkerReady?.(instanceId, workerId);
					}
					break;
				}
				case "worker.heartbeat": {
					deps.leases.updateHeartbeat(activeLease.workerId);
					break;
				}
				case "worker.state": {
					const observation = mapWorkerStateToObservation(msg.payload.to);
					if (observation) {
						observeWorkerLease(observation, msg.payload.reason);
					}
					break;
				}
				case "worker.input_consumed": {
					inputAckHandler.handle(instanceId, msg.payload);
					break;
				}
				case "worker.event": {
					eventIngestor.ingestWorkerEvent({ instanceId, workerId, payload: msg.payload });
					break;
				}
				case "worker.question_requested": {
					void deps.processQuestions
						?.handleWorkerRequest(instanceId, activeLease.id, workerId, msg.payload)
						.catch(() =>
							callbacks.onWorkerFailed?.(
								instanceId,
								workerId,
								"Worker question request could not be persisted",
							),
						);
					break;
				}
				case "worker.turn_started": {
					void deps.commands
						.acceptWorkerTurnStart(instanceId, {
							workerLeaseId: activeLease.id,
							startRecordId: msg.payload.startRecordId,
							proposedTurnRecordId: msg.payload.proposedTurnRecordId,
						})
						.then((result) => {
							if (!result.ok || !result.data) {
								callbacks.onWorkerFailed?.(instanceId, workerId, "Worker turn start was rejected");
								return;
							}
							eventIngestor.noteTurnStarted(instanceId, result.data.turnRecordId);
							launchCoordinator?.observeFirstTurnStarted(instanceId, workerId);
							callbacks.onWorkerTurnStartAccepted?.(instanceId, workerId, {
								startRecordId: msg.payload.startRecordId,
								turnRecordId: result.data.turnRecordId,
							});
						})
						.catch(() =>
							callbacks.onWorkerFailed?.(instanceId, workerId, "Worker turn start failed"),
						);
					break;
				}
				case "worker.turn_outcome": {
					turnRecorder.recordTurnOutcome(instanceId, workerId, msg.payload);
					break;
				}
				case "worker.turn_failed": {
					turnRecorder.recordTurnFailed(instanceId, workerId, msg.payload);
					break;
				}
				case "worker.lifecycle_parked": {
					const { errorClass, ...payload } = msg.payload;
					if (errorClass !== undefined && !isWorkerErrorClass(errorClass)) {
						break;
					}
					void deps.commands
						.parkProcessLifecycle(instanceId, {
							errorClass,
							...payload,
						})
						.catch(() => {});
					break;
				}
				case "worker.cleanup_started": {
					const process = deps.processes.getById(instanceId);
					if (!process) {
						break;
					}
					deps.events.create({
						instanceId,
						eventType: "cleanup_started",
						data: { reason: msg.payload.reason },
					});
					deps.broadcaster.broadcast(
						createDurableWsFrame({
							type: "process.event",
							payload: {
								eventType: "cleanup_started",
								level: "info",
								message: `Worker cleanup started: ${msg.payload.reason || "normal shutdown"}`,
							},
							instanceId,
						}),
					);
					break;
				}
				case "worker.cleanup_completed": {
					eventIngestor.clearLiveTurnState(instanceId);
					const result = observeWorkerLease("cleanup_completed", "worker.cleanup_completed");
					if (result.kind !== "applied") {
						break;
					}
					const process = deps.processes.getById(instanceId);
					if (process) {
						deps.events.create({
							instanceId,
							eventType: "cleanup_completed",
							data: {
								releasedLocks: msg.payload.releasedLocks,
								removedTransientPaths: msg.payload.removedTransientPaths,
							},
						});
						deps.broadcaster.broadcast(
							createDurableWsFrame({
								type: "process.event",
								payload: {
									eventType: "cleanup_completed",
									level: "info",
									message: "Worker cleanup completed",
								},
								instanceId,
							}),
						);
					}
					callbacks.onCleanupCompleted?.(instanceId, workerId);
					break;
				}
				case "worker.failed": {
					eventIngestor.clearLiveTurnState(instanceId);
					launchCoordinator?.observeWorkerFailure(instanceId, workerId, msg.payload.message);
					const result = observeWorkerLease("failure_reported", msg.payload.errorCode);
					if (result.kind !== "applied") {
						break;
					}
					const process = deps.processes.getById(instanceId);
					if (process) {
						deps.events.create({
							instanceId,
							eventType: "worker_failed",
							data: {
								message: msg.payload.message,
								errorCode: msg.payload.errorCode,
								errorClass: msg.payload.errorClass,
								selectedTurnId: msg.payload.selectedTurnId,
								workerId,
							},
						});
						deps.broadcaster.broadcast(
							createDurableWsFrame({
								type: "process.event",
								payload: {
									eventType: "worker_failed",
									level: "error",
									message: `Worker failed: ${msg.payload.message}`,
								},
								instanceId,
							}),
						);
						const workerFailureErrorClass = isWorkerErrorClass(msg.payload.errorClass)
							? msg.payload.errorClass
							: "infrastructure";
						void deps.commands
							.recordWorkerFailure(instanceId, {
								errorCode: msg.payload.errorCode,
								message: msg.payload.message,
								errorClass: workerFailureErrorClass,
								workerLeaseId: activeLease.id,
							})
							.catch(() => {});
					}
					callbacks.onWorkerFailed?.(instanceId, workerId, msg.payload.message);
					break;
				}
			}
		},
	};
}

export type IpcHandler = ReturnType<typeof createIpcHandler>;
