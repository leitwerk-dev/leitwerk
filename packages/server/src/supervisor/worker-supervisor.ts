import { randomUUID } from "node:crypto";
import {
	parseResolvedExtensionEntries,
	RUNTIME_EXTENSION_ALLOWED_ROOTS_ENV,
	RUNTIME_EXTENSION_ENTRIES_ENV,
} from "@leitwerk-dev/extension-runtime";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { PiResourceBundle } from "@leitwerk-dev/worker-protocol";
import {
	createIpcMessage,
	type InputDelivery,
	type IpcEnvelope,
	type ServerToWorkerMessage,
	WORKER_ID_ENV,
	WORKER_INSTANCE_ID_ENV,
	WORKER_IPC_CONNECT_TOKEN_ENV,
	WORKER_IPC_RECONNECT_ENV,
	WORKER_IPC_SERVER_URL_ENV,
	WORKER_SERVER_EPOCH_ENV,
	WORKER_SNAPSHOT_TOKEN_ENV,
	type WorkerCredentialUpdateResultPayload,
	type WorkerHelloPayload,
	type WorkerIntegrationToolResultPayload,
	type WorkerQuestionResponsePayload,
	type WorkerTurnTerminalRecordedPayload,
} from "@leitwerk-dev/worker-protocol";
import type {
	ProcessVolume,
	WorkerExitInfo,
	WorkerRunner,
	WorkerUnit,
} from "@leitwerk-dev/worker-runners/types";
import { WorkerStartDiagnosticError } from "@leitwerk-dev/worker-runners/types";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { LaunchCoordinator } from "../launch-coordinator.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import { getProcessTurnGraph, type ProcessGraphRegistry } from "../process-graph.js";
import type { ServerProcessModelPolicy } from "../process-model-policy/index.js";
import {
	buildRuntimeProfileSelectionInput,
	selectWorkerRuntimeProfile,
} from "../worker-runtime-profile-selection.js";
import type { Broadcaster } from "../ws/broadcast.js";
import { resolveAcceptedTurnStartReplay } from "./accepted-turn-start-replay.js";
import { createWorkerAdoptionCoordinator } from "./adoption/worker-adoption-coordinator.js";
import { decideIdleWorkerStop } from "./idle-worker-ttl.js";
import type { createIpcHandler } from "./ipc-handler.js";
import { createStartupObserver } from "./startup-observer.js";
import { createServerObservedWorkerFailedMessage } from "./synthetic-worker-failure.js";
import { checkWorkerApiCompatibility } from "./worker-api-compatibility.js";
import { createWorkerConnectToken, hashWorkerConnectToken } from "./worker-connect-token.js";
import {
	type ApplyWorkerLeaseObservationResult,
	applyWorkerLeaseObservation,
} from "./worker-lease-observer.js";
import { createWorkerShutdownController } from "./worker-shutdown-controller.js";
import {
	createWorkerStartPayloadBuilder,
	type WorkerStartPayloadBuilderDeps,
} from "./worker-start-payload-builder.js";
import { resolveWorkerPiAgentDir } from "./worker-storage-layout.js";
import {
	createWorkerUnitReclaimer,
	type WorkerUnitCleanupLogger,
} from "./worker-unit-reclaimer.js";
import {
	WorkerOutboundBufferOverflowError,
	type WorkerWebSocketIpcManager,
} from "./worker-websocket-ipc.js";

export interface SupervisorDeps
	extends Pick<
		RepositoryBundle,
		"leases" | "processes" | "projects" | "inputs" | "turnRecords" | "turnStarts" | "events"
	> {
	startupObservations?: RepositoryBundle["startupObservations"];
	config: LeitwerkConfig;
	getLaunchCoordinator?: () => LaunchCoordinator | undefined;
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: ProcessActionRegistry;
	processModelPolicy: ServerProcessModelPolicy;
	ipcHandler: ReturnType<typeof createIpcHandler>;
	broadcaster: Broadcaster;
	runnerRuntime: {
		runner: WorkerRunner;
		volume?: ProcessVolume;
		webSocketIpc: WorkerWebSocketIpcManager;
	};
	resolvedExtensionEntriesJson?: string;
	serverEpoch?: string;
	logger?: WorkerUnitCleanupLogger;
	resolveResourceBundle?: (digest: string) => PiResourceBundle | null;
	resolveRepositoryCredentials?: WorkerStartPayloadBuilderDeps["resolveRepositoryCredentials"];
	integrationTools?: WorkerStartPayloadBuilderDeps["integrationTools"];
	resolveCredential?: WorkerStartPayloadBuilderDeps["resolveCredential"];
}

export interface WorkerHandle {
	workerId: string;
	instanceId: string;
	/** Runtime-specific handle id when known; used to distinguish duplicate units during adoption scans. */
	unitId?: string;
	namespace?: string;
	send(message: ServerToWorkerMessage): void;
	kill(signal?: NodeJS.Signals | number): void;
	/** Stops the physical runtime and rejects if disappearance cannot be confirmed. */
	killAndWait?(signal?: NodeJS.Signals | number): Promise<void>;
	detach(reason: string): void;
	onceExit(listener: () => void): void;
}

interface RunnerWorkerStartOptions {
	instanceId: string;
	workerId: string;
	startupDeadlineMs: number;
	resolvedExtensionEntriesJson?: string;
	snapshotToken?: string;
	onEnvelope(envelope: IpcEnvelope): void;
	onInvalidMessage(): void;
	onRuntimeError(error: unknown): void;
	onRuntimeExit(): void;
}

type ServerToWorkerMessageBody<T = ServerToWorkerMessage> = T extends ServerToWorkerMessage
	? Pick<T, "type" | "payload">
	: never;

export interface WorkerSupervisor {
	spawnWorker(instanceId: string): Promise<WorkerHandle>;
	stopWorker(instanceId: string, reason: string): Promise<void>;
	abortTurn(instanceId: string, reason: string): void;
	deliverInputs(instanceId: string, inputs: InputDelivery[]): void;
	acceptTurnStart(
		instanceId: string,
		workerId: string,
		startRecordId: string,
		turnRecordId: string,
	): void;
	reconcileAcceptedTurnStart(instanceId: string, workerId: string): boolean;
	acknowledgeTurnTerminal(
		instanceId: string,
		workerId: string,
		payload: WorkerTurnTerminalRecordedPayload,
	): void;
	questionResponse(
		instanceId: string,
		workerId: string,
		payload: WorkerQuestionResponsePayload,
	): void;
	credentialUpdateResult(
		instanceId: string,
		workerId: string,
		payload: WorkerCredentialUpdateResultPayload,
	): void;
	integrationToolResult(
		instanceId: string,
		workerId: string,
		payload: WorkerIntegrationToolResultPayload,
	): void;
	getWorker(instanceId: string): WorkerHandle | undefined;
	isAdoptionPending(instanceId: string): boolean;
	adoptRegisteredWorkers(): Promise<void>;
	detachAll(reason: string): Promise<void>;
	shutdownAll(reason: string): Promise<void>;
}

function generateWorkerId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 10);
	return `wkr_${ts}${rand}`;
}

export function createWorkerSupervisor(deps: SupervisorDeps): WorkerSupervisor {
	const workers = new Map<string, WorkerHandle>();
	const startupTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const startupTimedOutWorkers = new Set<string>();
	const idleStopTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const pendingCleanup = new Map<string, () => void>();
	const runnerRuntime = deps.runnerRuntime;
	const unitReclaimer = createWorkerUnitReclaimer({
		runner: runnerRuntime.runner,
		logger: deps.logger,
	});

	function sendToCurrentWorker(
		instanceId: string,
		workerId: string,
		message: ServerToWorkerMessageBody,
	): void {
		const worker = workers.get(instanceId);
		if (!worker || worker.workerId !== workerId) return;
		worker.send(
			createIpcMessage<ServerToWorkerMessage>({
				...message,
				messageId: randomUUID(),
				instanceId,
				workerId,
			}),
		);
	}
	const startPayloadBuilder = createWorkerStartPayloadBuilder(deps);
	const serverEpoch = deps.serverEpoch ?? `epoch_${Date.now().toString(36)}`;
	const startupTimeoutMs = parseDurationMs(deps.config.workers.startup_timeout, 30_000, {
		allowHours: true,
	});
	const startupDiagnosticMarginMs = Math.min(5_000, Math.max(1, Math.floor(startupTimeoutMs / 2)));
	const idleWorkerTtlMs = parseDurationMs(deps.config.workers.idle_worker_ttl, 0, {
		allowHours: true,
	});
	let adoptionCoordinator: ReturnType<typeof createWorkerAdoptionCoordinator>;

	function observeWorkerLease(
		instanceId: string,
		workerId: string,
		observation: Parameters<typeof applyWorkerLeaseObservation>[1]["observation"],
		reason?: string,
	): ApplyWorkerLeaseObservationResult {
		const process = observation === "spawn_requested" ? deps.processes.getById(instanceId) : null;
		const result = applyWorkerLeaseObservation(
			{ leases: deps.leases, broadcaster: deps.broadcaster },
			{
				instanceId,
				workerId,
				observation,
				reason,
				turnStartRecordId:
					process?.currentExecution?.kind === "worker_start" ? process.currentExecution.id : null,
			},
		);
		if (result.kind === "applied") deps.getLaunchCoordinator?.()?.refresh(instanceId);
		return result;
	}

	function safeGetLeaseByInstance(instanceId: string) {
		try {
			return deps.leases.getByInstance(instanceId);
		} catch {
			return null;
		}
	}

	function safeGetProcessById(instanceId: string) {
		try {
			return deps.processes.getById(instanceId);
		} catch {
			return null;
		}
	}

	function requireAppliedWorkerLeaseObservation(
		instanceId: string,
		workerId: string,
		observation: Parameters<typeof applyWorkerLeaseObservation>[1]["observation"],
		reason?: string,
	): void {
		const result = observeWorkerLease(instanceId, workerId, observation, reason);
		if (result.kind === "applied") {
			return;
		}
		const detail =
			result.kind === "ignored"
				? result.reason
				: result.kind === "invalid"
					? result.transition.message
					: result.transition.reason;
		throw new Error(
			`Failed to apply worker lease observation '${observation}' for process ${instanceId} worker ${workerId}: ${detail}`,
		);
	}

	function clearStartupTimer(instanceId: string): void {
		const timer = startupTimers.get(instanceId);
		if (timer === undefined) {
			return;
		}
		clearTimeout(timer);
		startupTimers.delete(instanceId);
	}

	function clearIdleStopTimer(instanceId: string): void {
		const timer = idleStopTimers.get(instanceId);
		if (timer === undefined) {
			return;
		}
		clearTimeout(timer);
		idleStopTimers.delete(instanceId);
	}

	function selectedTurnForProcess(instanceId: string) {
		const process = safeGetProcessById(instanceId);
		if (!process?.selectedTurnId) {
			return { process, selectedTurn: null };
		}
		return {
			process,
			selectedTurn: getProcessTurnGraph(
				deps.processGraphs,
				process.processId,
				process.selectedTurnId,
			),
		};
	}

	function scheduleIdleStopIfEligible(instanceId: string, workerId: string): void {
		clearIdleStopTimer(instanceId);
		if (idleWorkerTtlMs <= 0) {
			return;
		}
		const timer = setTimeout(() => {
			idleStopTimers.delete(instanceId);
			const { process, selectedTurn } = selectedTurnForProcess(instanceId);
			const decision = decideIdleWorkerStop({
				idleTtlMs: idleWorkerTtlMs,
				hasWorkerHandle: workers.get(instanceId)?.workerId === workerId,
				lease: safeGetLeaseByInstance(instanceId),
				workerId,
				process,
				selectedTurn,
				unconsumedInputs: deps.inputs.listUnconsumed(instanceId),
			});
			if (!decision.shouldStop) {
				return;
			}
			void shutdownController.stopWorker(instanceId, "idle_worker_ttl");
		}, idleWorkerTtlMs);
		idleStopTimers.set(instanceId, timer);
	}

	function timedOutWorkerKey(instanceId: string, workerId: string): string {
		return `${instanceId}/${workerId}`;
	}

	function startWorkerStartupTimer(
		instanceId: string,
		handle: WorkerHandle,
		startupDeadlineMs: number,
	): void {
		const timer = setTimeout(
			() => {
				clearStartupTimer(instanceId);
				// Let the runtime exit observation carry bounded Pod events into the
				// durable failure instead of recording a generic timeout first.
				startupTimedOutWorkers.add(timedOutWorkerKey(instanceId, handle.workerId));
				handle.kill("SIGKILL");
			},
			Math.max(0, startupDeadlineMs - Date.now()),
		);
		startupTimers.set(instanceId, timer);
	}

	function emitServerObservedWorkerFailure(
		instanceId: string,
		workerId: string,
		payload: {
			errorCode: string;
			message: string;
			errorClass?: string;
			selectedTurnId?: string | null;
		},
	): void {
		try {
			routeEnvelope(
				createServerObservedWorkerFailedMessage({
					instanceId,
					workerId,
					state: safeGetLeaseByInstance(instanceId)?.state ?? "absent",
					errorCode: payload.errorCode,
					message: payload.message,
					errorClass: payload.errorClass,
					selectedTurnId:
						payload.selectedTurnId ?? safeGetProcessById(instanceId)?.selectedTurnId ?? null,
				}),
				instanceId,
			);
		} catch {
			// During shutdown, late runtime events can arrive after the DB is closed.
		}
	}

	function failWorkerForInvalidProcessState(
		instanceId: string,
		handle: WorkerHandle,
		error: unknown,
	): void {
		const message = error instanceof Error ? error.message : String(error);
		clearStartupTimer(instanceId);
		emitServerObservedWorkerFailure(instanceId, handle.workerId, {
			errorCode: "invalid_process_state",
			message,
			errorClass: "infrastructure",
		});
		handle.kill("SIGKILL");
	}

	function sendInputBatch(
		instanceId: string,
		handle: WorkerHandle,
		inputs: InputDelivery[],
	): boolean {
		if (inputs.length === 0) {
			return false;
		}
		const msg = createIpcMessage<ServerToWorkerMessage>({
			type: "input.batch",
			instanceId,
			workerId: handle.workerId,
			messageId: randomUUID(),
			payload: { inputs },
		});
		handle.send(msg);
		return true;
	}

	function isLeaseStillBootstrapping(instanceId: string, workerId: string): boolean {
		const lease = safeGetLeaseByInstance(instanceId);
		return (
			lease?.workerId === workerId &&
			(lease.state === "spawning" || lease.state === "bootstrapping")
		);
	}

	function reconcileAcceptedTurnStart(instanceId: string, workerId: string): boolean {
		if (workers.get(instanceId)?.workerId !== workerId) return false;
		const replay = resolveAcceptedTurnStartReplay(deps, instanceId, workerId);
		if (!replay) return false;
		sendToCurrentWorker(instanceId, workerId, {
			type: "worker.turn_start_accepted",
			payload: replay,
		});
		return true;
	}

	function routeEnvelope(envelope: IpcEnvelope, instanceId: string): void {
		const currentHandle = workers.get(instanceId);
		if (
			envelope.instanceId !== instanceId ||
			(currentHandle && envelope.workerId !== currentHandle.workerId)
		) {
			if (currentHandle) {
				emitServerObservedWorkerFailure(instanceId, currentHandle.workerId, {
					errorCode: "invalid_worker_identity",
					message: "Worker emitted IPC for a different process or worker id",
					errorClass: "infrastructure",
				});
				currentHandle.kill("SIGKILL");
			}
			return;
		}
		deps.ipcHandler.handleMessage(envelope);
		if (envelope.type === "worker.hello") {
			const handle = workers.get(instanceId);
			const compatibility = checkWorkerApiCompatibility(
				envelope.payload as WorkerHelloPayload,
				undefined,
				{
					requireApiVersion: deps.config.workers.runner !== "local",
				},
			);
			if (!compatibility.ok) {
				if (handle) {
					emitServerObservedWorkerFailure(instanceId, handle.workerId, {
						errorCode: "incompatible_worker_api_version",
						message: compatibility.error ?? "Worker API version is incompatible with this server",
						errorClass: "infrastructure",
					});
					handle.kill("SIGKILL");
				}
				return;
			}
			const lease = deps.leases.getByInstance(instanceId);
			if (
				handle &&
				handle.workerId === envelope.workerId &&
				lease &&
				lease.workerId === envelope.workerId &&
				lease.state === "bootstrapping"
			) {
				try {
					const startMessage = startPayloadBuilder.buildStartMessage(instanceId, handle.workerId);
					if (startMessage) {
						handle.send(startMessage);
					}
				} catch (error) {
					failWorkerForInvalidProcessState(instanceId, handle, error);
				}
			}
		}
		if (envelope.type === "worker.heartbeat") {
			adoptionCoordinator.onHeartbeat(instanceId, envelope.workerId, envelope.payload);
			const reportedState =
				typeof envelope.payload === "object" &&
				envelope.payload !== null &&
				"state" in envelope.payload
					? envelope.payload.state
					: null;
			if (reportedState === "idle") {
				reconcileAcceptedTurnStart(instanceId, envelope.workerId);
			}
		}
		if (envelope.type === "worker.ready") {
			adoptionCoordinator.onWorkerReady(instanceId);
			clearStartupTimer(instanceId);
			scheduleIdleStopIfEligible(instanceId, envelope.workerId);
		}
		if (envelope.type === "worker.state") {
			const nextState =
				typeof envelope.payload === "object" && envelope.payload !== null
					? (envelope.payload as { to?: unknown }).to
					: null;
			if (nextState === "idle") {
				scheduleIdleStopIfEligible(instanceId, envelope.workerId);
			} else if (nextState === "busy" || nextState === "draining") {
				clearIdleStopTimer(instanceId);
			}
		}
		if (envelope.type === "worker.cleanup_completed") {
			const resolve = pendingCleanup.get(instanceId);
			if (resolve) {
				pendingCleanup.delete(instanceId);
				resolve();
			}
		}
	}

	function finalizeLeaseExit(instanceId: string, workerId: string): void {
		try {
			observeWorkerLease(instanceId, workerId, "process_exited", "process_exit");
		} catch {
			// Ignore late process-exit notifications after shutdown has already closed storage.
		}
	}

	const shutdownController = createWorkerShutdownController({
		config: deps.config,
		workers,
		pendingCleanup,
		observeWorkerLease,
		getLeaseByInstance: safeGetLeaseByInstance,
	});

	function handleProcessError(instanceId: string, workerId: string, error: unknown): void {
		clearStartupTimer(instanceId);
		clearIdleStopTimer(instanceId);
		const leaseBeforeError = safeGetLeaseByInstance(instanceId);
		const shouldNormalizeProcessError =
			leaseBeforeError?.workerId === workerId &&
			leaseBeforeError.state !== "draining" &&
			leaseBeforeError.state !== "cleanup" &&
			leaseBeforeError.state !== "failed" &&
			leaseBeforeError.state !== "exited";
		const shouldStopWorker = error instanceof WorkerOutboundBufferOverflowError;
		if (!shouldNormalizeProcessError) {
			if (shouldStopWorker) {
				const handle = workers.get(instanceId);
				if (handle?.workerId === workerId) {
					handle.kill("SIGKILL");
				}
			}
			return;
		}
		const errorMessage = error instanceof Error ? error.message : String(error);
		const startupTimedOut = startupTimedOutWorkers.delete(timedOutWorkerKey(instanceId, workerId));
		const failedBeforeBootstrap =
			leaseBeforeError.state === "spawning" || leaseBeforeError.state === "bootstrapping";
		emitServerObservedWorkerFailure(instanceId, workerId, {
			errorCode: shouldStopWorker
				? "worker_websocket_outbound_buffer_overflow"
				: startupTimedOut
					? "startup_timeout"
					: failedBeforeBootstrap
						? "spawn_error"
						: "process_error",
			message: startupTimedOut
				? `Worker startup timed out after ${startupTimeoutMs}ms: ${errorMessage}`
				: failedBeforeBootstrap
					? `Worker process error before bootstrap completed: ${errorMessage}`
					: `Worker process error: ${errorMessage}`,
			errorClass: "infrastructure",
		});
		if (shouldStopWorker) {
			const handle = workers.get(instanceId);
			if (handle?.workerId === workerId) {
				handle.kill("SIGKILL");
			}
		}
	}

	function formatWorkerExitDiagnostics(info?: WorkerExitInfo): string {
		if (!info) return "";
		const parts: string[] = [];
		if (info.exitCode !== null) parts.push(`exitCode=${info.exitCode}`);
		if (info.signal) parts.push(`signal=${info.signal}`);
		if (info.oomKilled) parts.push("oomKilled=true");
		if (info.reason) parts.push(`reason=${info.reason}`);
		return parts.length > 0 ? ` (${parts.join(", ")})` : "";
	}

	function handleProcessExit(instanceId: string, workerId: string, info?: WorkerExitInfo): void {
		clearStartupTimer(instanceId);
		clearIdleStopTimer(instanceId);
		adoptionCoordinator.clear(instanceId);
		pendingCleanup.delete(instanceId);
		const leaseBeforeExit = safeGetLeaseByInstance(instanceId);
		const startupTimedOut = startupTimedOutWorkers.delete(timedOutWorkerKey(instanceId, workerId));
		const shouldNormalizeUnexpectedExit =
			leaseBeforeExit?.workerId === workerId &&
			leaseBeforeExit.state !== "draining" &&
			leaseBeforeExit.state !== "cleanup" &&
			leaseBeforeExit.state !== "failed" &&
			leaseBeforeExit.state !== "exited";
		if (shouldNormalizeUnexpectedExit) {
			const diagnostics = formatWorkerExitDiagnostics(info);
			emitServerObservedWorkerFailure(instanceId, workerId, {
				errorCode: startupTimedOut
					? "startup_timeout"
					: info?.oomKilled
						? "process_oom_killed"
						: "process_exited",
				message: startupTimedOut
					? `Worker startup timed out after ${startupTimeoutMs}ms${diagnostics}`
					: leaseBeforeExit?.state === "spawning" || leaseBeforeExit?.state === "bootstrapping"
						? `Worker exited before bootstrap completed${diagnostics}`
						: `Worker exited unexpectedly${diagnostics}`,
				errorClass: "infrastructure",
			});
		}
		workers.delete(instanceId);
		finalizeLeaseExit(instanceId, workerId);
	}

	function createRunnerHandle(input: {
		unit: WorkerUnit;
		unregister(reason: string): void;
		onRuntimeExit?: () => void;
	}): WorkerHandle {
		const exitListeners: Array<() => void> = [];
		unitReclaimer.observeExit(input.unit, (info) => {
			input.unregister("runtime_exit");
			handleProcessExit(input.unit.instanceId, input.unit.workerId, info);
			input.onRuntimeExit?.();
			for (const listener of exitListeners.splice(0)) listener();
		});
		return {
			instanceId: input.unit.instanceId,
			workerId: input.unit.workerId,
			unitId: input.unit.unitId,
			namespace: input.unit.namespace,
			send(message) {
				runnerRuntime.webSocketIpc.send(input.unit.instanceId, input.unit.workerId, message);
			},
			kill(signal?: NodeJS.Signals | number) {
				input.unregister("process_killed");
				void runnerRuntime.runner
					.stop(input.unit, { graceMs: signal === "SIGTERM" ? 1000 : 0 })
					.catch((error) => handleProcessError(input.unit.instanceId, input.unit.workerId, error));
			},
			async killAndWait(signal?: NodeJS.Signals | number) {
				input.unregister("process_killed");
				await runnerRuntime.runner.stop(input.unit, {
					graceMs: signal === "SIGTERM" ? 1000 : 0,
				});
			},
			detach(reason: string) {
				input.unregister(reason);
			},
			onceExit(listener) {
				exitListeners.push(listener);
			},
		};
	}

	function registerRunnerWebSocket(input: {
		instanceId: string;
		workerId: string;
		tokenHash: string;
		onEnvelope(envelope: IpcEnvelope): void;
		onInvalidMessage(): void;
		onRuntimeError(error: unknown): void;
	}): { unregister(reason: string): void } {
		if (!runnerRuntime) {
			throw new Error("runner runtime is not configured");
		}
		runnerRuntime.webSocketIpc.registerWorker({
			instanceId: input.instanceId,
			workerId: input.workerId,
			callbacks: {
				onEnvelope: input.onEnvelope,
				onInvalidOutput: input.onInvalidMessage,
				onRuntimeError: input.onRuntimeError,
			},
			tokenHash: input.tokenHash,
		});
		return {
			unregister(reason: string) {
				runnerRuntime.webSocketIpc.unregister(input.instanceId, input.workerId, reason);
			},
		};
	}

	function resolveRunnerStartSelection(instanceId: string) {
		const process = deps.processes.getById(instanceId);
		if (!process) {
			throw new Error(`Cannot start worker for missing process ${instanceId}`);
		}
		if (deps.config.workers.runner === "local") {
			return {
				selection: {
					ok: true as const,
					runtimeProfile: "local",
					image: { reference: "local" },
				},
				profile: undefined,
			};
		}
		const selection = selectWorkerRuntimeProfile(
			buildRuntimeProfileSelectionInput({
				config: deps.config,
				processId: process.processId,
				componentKeys: deps.projects.listByInstance(instanceId).map((project) => project.key),
			}),
		);
		if (!selection.ok) {
			throw new Error(selection.error);
		}
		const profile = deps.config.worker_runtime_profiles?.[selection.runtimeProfile];
		return { selection, profile };
	}

	function runnerServerUrl(): string {
		if (deps.config.workers.runner === "kubernetes") {
			return deps.config.kubernetes?.server_url ?? deps.config.server.base_url;
		}
		if (deps.config.workers.runner === "docker") {
			return deps.config.docker?.server_url ?? deps.config.server.base_url;
		}
		return deps.config.server.base_url;
	}

	async function startRunnerWorker(
		options: RunnerWorkerStartOptions,
		connect: { token: string; unregister(reason: string): void },
	): Promise<WorkerHandle> {
		const { selection, profile } = resolveRunnerStartSelection(options.instanceId);
		const process = deps.processes.getById(options.instanceId);
		if (!process) throw new Error(`Cannot start worker for missing process ${options.instanceId}`);
		const docker = deps.processGraphs.get(process.processId)?.runtime?.docker === true;
		const resourceLimits =
			profile?.resources?.limits ??
			(profile?.resources
				? { cpu: profile.resources.cpu, memory: profile.resources.memory }
				: undefined);
		const observer = createStartupObserver(
			deps,
			options.instanceId,
			options.workerId,
			options.startupDeadlineMs,
		);
		const volume = await runnerRuntime.volume?.ensure(options.instanceId, { docker }, observer);
		const serverUrl = runnerServerUrl();
		const env: Record<string, string> = {
			[WORKER_INSTANCE_ID_ENV]: options.instanceId,
			[WORKER_ID_ENV]: options.workerId,
			[WORKER_IPC_SERVER_URL_ENV]: serverUrl,
			[WORKER_IPC_CONNECT_TOKEN_ENV]: connect.token,
			[WORKER_IPC_RECONNECT_ENV]: "1",
			[WORKER_SERVER_EPOCH_ENV]: serverEpoch,
			PI_CODING_AGENT_DIR: resolveWorkerPiAgentDir(deps.config, volume?.mountPath),
			LEITWERK_WORKER_STARTUP_TIMEOUT_MS: String(startupTimeoutMs),
			LEITWERK_WORKER_STARTUP_DEADLINE_MS: String(
				options.startupDeadlineMs - startupDiagnosticMarginMs,
			),
		};
		if (options.snapshotToken) env[WORKER_SNAPSHOT_TOKEN_ENV] = options.snapshotToken;
		if (options.resolvedExtensionEntriesJson) {
			env[RUNTIME_EXTENSION_ENTRIES_ENV] = options.resolvedExtensionEntriesJson;
			if (deps.config.workers.runner === "local") {
				env[RUNTIME_EXTENSION_ALLOWED_ROOTS_ENV] = JSON.stringify(
					parseResolvedExtensionEntries(options.resolvedExtensionEntriesJson).map(
						(entry) => entry.packageDir,
					),
				);
			}
		}
		const unit = await runnerRuntime.runner.start(
			{
				instanceId: options.instanceId,
				workerId: options.workerId,
				serverEpoch,
				image: selection.image,
				env,
				...(volume
					? { runnerKind: "isolated" as const, volume }
					: { runnerKind: "local" as const }),
				docker,
				resources: resourceLimits,
			},
			observer,
		);
		return createRunnerHandle({
			unit,
			unregister: connect.unregister,
			onRuntimeExit: options.onRuntimeExit,
		});
	}

	const modelPolicyFingerprintForProcess = (
		process: import("@leitwerk-dev/domain").ProcessInstance,
	) => {
		if (process.currentExecution?.kind !== "worker_start") {
			throw new Error(`Process '${process.id}' has no current worker start to fingerprint`);
		}
		const currentStart = deps.turnStarts.getById(process.currentExecution.id);
		if (!currentStart)
			throw new Error(`Current turn start '${process.currentExecution.id}' is missing`);
		return deps.processModelPolicy.fingerprint({ process, currentStart });
	};

	adoptionCoordinator = createWorkerAdoptionCoordinator({
		startupObserver: (descriptor) =>
			createStartupObserver(
				deps,
				descriptor.instanceId,
				descriptor.workerId,
				Date.parse(deps.leases.getByInstance(descriptor.instanceId)?.startedAt ?? "") +
					startupTimeoutMs,
			),
		startupTimeoutMs,
		serverEpoch,
		runnerRuntime,
		unitReclaimer,
		workers,
		leases: deps.leases,
		inputs: deps.inputs,
		safeGetLeaseByInstance,
		safeGetProcessById,
		modelPolicyFingerprintForProcess,
		isLeaseStillBootstrapping,
		routeEnvelope,
		handleProcessError,
		emitServerObservedWorkerFailure,
		createRunnerHandle,
		sendInputBatch,
	});

	return {
		async spawnWorker(instanceId: string): Promise<WorkerHandle> {
			unitReclaimer.assertProcessReclaimed(instanceId);
			clearIdleStopTimer(instanceId);
			if (workers.has(instanceId)) {
				throw new Error(`worker already running for process ${instanceId}`);
			}
			if (workers.size >= deps.config.workers.max_parallel_processes) {
				throw new Error("max_parallel_processes reached");
			}
			const workerId = generateWorkerId();
			const connectToken = createWorkerConnectToken();
			const connectTokenHash = hashWorkerConnectToken(connectToken);
			const snapshotToken = createWorkerConnectToken();
			requireAppliedWorkerLeaseObservation(
				instanceId,
				workerId,
				"spawn_requested",
				"spawn_requested",
			);
			const lease = deps.leases.getByInstance(instanceId);
			if (lease?.workerId === workerId) {
				const process = deps.processes.getById(instanceId);
				deps.leases.update(lease.id, {
					serverEpoch,
					connectTokenHash,
					snapshotTokenHash: hashWorkerConnectToken(snapshotToken),
					modelPolicyFingerprint: process ? modelPolicyFingerprintForProcess(process) : null,
				});
			}

			let handle: WorkerHandle;
			const startupDeadlineMs = Date.now() + startupTimeoutMs;
			let processExitedBeforeRegistration = false;
			let unregisterStartRegistration: (() => void) | undefined;
			const earlyEnvelopes: IpcEnvelope[] = [];
			try {
				const startOptions: RunnerWorkerStartOptions = {
					instanceId,
					workerId,
					startupDeadlineMs,
					resolvedExtensionEntriesJson: deps.resolvedExtensionEntriesJson,
					onEnvelope: (envelope) => {
						if (workers.has(instanceId)) {
							routeEnvelope(envelope, instanceId);
						} else {
							earlyEnvelopes.push(envelope);
						}
					},
					onInvalidMessage: () => {
						emitServerObservedWorkerFailure(instanceId, workerId, {
							errorCode: "invalid_worker_websocket_ipc",
							message: "Worker emitted invalid WebSocket IPC message",
							errorClass: "infrastructure",
						});
					},
					onRuntimeError: (error) => handleProcessError(instanceId, workerId, error),
					snapshotToken,
					onRuntimeExit: () => {
						processExitedBeforeRegistration = !workers.has(instanceId);
					},
				};
				const connect = registerRunnerWebSocket({
					instanceId,
					workerId,
					tokenHash: connectTokenHash,
					onEnvelope: startOptions.onEnvelope,
					onInvalidMessage: startOptions.onInvalidMessage,
					onRuntimeError: startOptions.onRuntimeError,
				});
				unregisterStartRegistration = () => connect.unregister("start_failed");
				handle = await startRunnerWorker(startOptions, {
					token: connectToken,
					unregister: connect.unregister,
				});
				unregisterStartRegistration = undefined;
			} catch (error) {
				unregisterStartRegistration?.();
				const diagnostic =
					error instanceof WorkerStartDiagnosticError ? ` ${error.publicDiagnostic}` : "";
				emitServerObservedWorkerFailure(instanceId, workerId, {
					errorCode: "worker_spawn_failed",
					message: `Process was created, but the worker could not be started cleanly. Review the process error and retry startup.${diagnostic}`,
					errorClass: "infrastructure",
				});
				observeWorkerLease(instanceId, workerId, "failure_reported", "spawn_failed");
				observeWorkerLease(instanceId, workerId, "process_exited", "spawn_failed");
				throw error;
			}

			if (!processExitedBeforeRegistration) {
				startWorkerStartupTimer(instanceId, handle, startupDeadlineMs);
				workers.set(instanceId, handle);
				for (const envelope of earlyEnvelopes) {
					routeEnvelope(envelope, instanceId);
				}
			}
			return handle;
		},

		async stopWorker(instanceId, reason) {
			clearIdleStopTimer(instanceId);
			await shutdownController.stopWorker(instanceId, reason);
		},

		abortTurn(instanceId: string, reason: string): void {
			const handle = workers.get(instanceId);
			if (!handle) {
				return;
			}
			const msg = createIpcMessage<ServerToWorkerMessage>({
				type: "worker.abort_turn",
				instanceId,
				workerId: handle.workerId,
				messageId: randomUUID(),
				payload: { reason },
			});
			handle.send(msg);
		},

		deliverInputs(instanceId: string, inputs: InputDelivery[]): void {
			const handle = workers.get(instanceId);
			if (!handle) {
				return;
			}
			if (sendInputBatch(instanceId, handle, inputs)) {
				clearIdleStopTimer(instanceId);
			}
		},
		acceptTurnStart(instanceId, workerId, startRecordId, turnRecordId) {
			sendToCurrentWorker(instanceId, workerId, {
				type: "worker.turn_start_accepted",
				payload: { startRecordId, turnRecordId },
			});
		},
		reconcileAcceptedTurnStart,
		acknowledgeTurnTerminal(instanceId, workerId, payload) {
			runnerRuntime.webSocketIpc.send(
				instanceId,
				workerId,
				createIpcMessage<ServerToWorkerMessage>({
					type: "worker.turn_terminal_recorded",
					payload,
					messageId: randomUUID(),
					instanceId,
					workerId,
				}),
			);
		},
		questionResponse(instanceId, workerId, payload) {
			sendToCurrentWorker(instanceId, workerId, { type: "worker.question_response", payload });
		},
		integrationToolResult(instanceId, workerId, payload) {
			sendToCurrentWorker(instanceId, workerId, {
				type: "worker.integration_tool_result",
				payload,
			});
		},
		credentialUpdateResult(instanceId, workerId, payload) {
			sendToCurrentWorker(instanceId, workerId, {
				type: "worker.credential_update_accepted",
				payload,
			});
		},

		getWorker(instanceId: string): WorkerHandle | undefined {
			return workers.get(instanceId);
		},

		isAdoptionPending(instanceId: string): boolean {
			return adoptionCoordinator.isPending(instanceId);
		},

		async adoptRegisteredWorkers(): Promise<void> {
			await adoptionCoordinator.adoptRegisteredWorkers();
		},

		async detachAll(reason: string): Promise<void> {
			const ids = [...workers.keys()];
			for (const id of ids) {
				clearStartupTimer(id);
				clearIdleStopTimer(id);
				adoptionCoordinator.clear(id);
				const handle = workers.get(id);
				workers.delete(id);
				handle?.detach?.(reason);
			}
		},

		async shutdownAll(reason: string): Promise<void> {
			const ids = [...workers.keys()];
			for (const id of ids) {
				clearStartupTimer(id);
				clearIdleStopTimer(id);
				if (deps.config.workers.runner === "local" && reason === "server_shutdown") {
					const handle = workers.get(id);
					handle?.kill("SIGKILL");
					continue;
				}
				await shutdownController.stopWorker(id, reason);
			}
		},
	};
}
