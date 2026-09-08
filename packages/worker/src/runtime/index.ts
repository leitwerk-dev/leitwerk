import type { ServerToWorkerMessage } from "@leitwerk-dev/worker-protocol";
import { MiseDevelopmentToolEnvironment } from "../development-tool-environment.js";
import { deliverBatch } from "../input-consumer.js";
import { WorkerIntegrationToolBridge } from "../integration-tool-bridge.js";
import type { WorkerIpc } from "../ipc.js";
import { createPiEventReporter } from "../pi-event-reporter.js";
import { WorkerQuestionBridge } from "../question-bridge.js";
import { resolveRootEntryIdFromHandle } from "../turn-tree-strategy.js";
import { createWorkerIpcReporter } from "../worker-ipc-reporter.js";
import type { WorkerRuntimeOptions, WorkerRuntimeTimer } from "./adapters.js";
import { sampleCredentialFiles, WorkerLiveResources } from "./bootstrap-session.js";
import {
	createInitialWorkerRuntimeState,
	reduceWorkerRuntime,
	type WorkerRuntimeCommand,
	type WorkerRuntimeEvent,
	type WorkerRuntimeOutput,
	type WorkerRuntimeStateMachine,
	type WorkerTimerName,
} from "./lifecycle-reducer.js";
import { resolveWorkerRuntimeSettings } from "./settings.js";
import { executeSelectedTurn } from "./turn-execution.js";

export {
	nodeWorkerRuntimeScheduler,
	type ResultImageToolFactory,
	type WorkerRuntimeAdapters,
	type WorkerRuntimeConfig,
	type WorkerRuntimeOptions,
	type WorkerRuntimeScheduler,
} from "./adapters.js";

export interface WorkerRuntime {
	start(): Promise<void>;
	stop(reason: string): Promise<void>;
}

/** One non-reentrant driver around the pure runtime reducer. */
export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
	const { config, adapters } = options;
	const sampleCredentials = adapters.sampleCredentials ?? sampleCredentialFiles;
	const ipc: WorkerIpc = adapters.transport;
	const queue: WorkerRuntimeEvent[] = [];
	const timers = new Map<WorkerTimerName, WorkerRuntimeTimer>();
	let state: WorkerRuntimeStateMachine = createInitialWorkerRuntimeState();
	let draining = false;
	let started = false;
	let invariantQueued = false;
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	const reporter = createWorkerIpcReporter({
		instanceId: config.instanceId,
		workerId: config.workerId,
		now: () => adapters.scheduler.now(),
		send: (message) => ipc.send(message),
		emitExtensionEvent: (event, payload) => adapters.extensionEvents?.emit(event, payload),
	});
	const questionBridge = new WorkerQuestionBridge(reporter);
	const integrationToolBridge = new WorkerIntegrationToolBridge(reporter);

	let dispatch: (event: WorkerRuntimeEvent) => void;
	const piEvents = createPiEventReporter({
		reporter,
		emitExtensionEvent: (event, payload) => adapters.extensionEvents?.emit(event, payload),
		getCurrentSelectedTurnId: () => state.session?.selectedTurnId ?? null,
		getSessionTainted: () => state.sessionTainted,
		onLifecycleObservation(kind) {
			dispatch({ kind });
		},
	});
	const resources = new WorkerLiveResources({
		instanceId: config.instanceId,
		piFactory: adapters.piFactory,
		gitOps: adapters.gitOps,
		developmentTools: adapters.developmentTools ?? new MiseDevelopmentToolEnvironment(),
		scheduler: adapters.scheduler,
		sessionSnapshots: adapters.sessionSnapshots,
		resolveWorkerProcess: adapters.resolveWorkerProcess,
		progress(payload) {
			reporter.workerTrace(payload, state.session?.selectedTurnId ?? null);
		},
		diagnosticTrace(text) {
			reporter.project({ kind: "protocol", type: "worker.diagnostic_trace", payload: { text } });
		},
	});

	const invariant = (error: unknown): void => {
		if (invariantQueued || state.phase.kind === "exited") return;
		invariantQueued = true;
		queue.push({ kind: "invariant_failed", error });
		if (!draining) drain();
	};

	const complete = (event: WorkerRuntimeEvent): void => dispatch(event);
	const launch = (command: WorkerRuntimeCommand): void => {
		switch (command.kind) {
			case "arm_timer": {
				const existing = timers.get(command.name);
				if (existing) adapters.scheduler.clearTimeout(existing);
				const handle = adapters.scheduler.setTimeout(() => {
					timers.delete(command.name);
					complete({ kind: "timer_fired", name: command.name, correlation: command.correlation });
				}, command.delayMs);
				timers.set(command.name, handle);
				return;
			}
			case "cancel_timer": {
				const timer = timers.get(command.name);
				if (timer) adapters.scheduler.clearTimeout(timer);
				timers.delete(command.name);
				return;
			}
			case "close_transport":
				for (const timer of timers.values()) adapters.scheduler.clearTimeout(timer);
				timers.clear();
				ipc.stop();
				resolveClosed();
				return;
			case "exit":
				adapters.exit(command.code);
				return;
			case "bootstrap":
				void resources
					.bootstrap(command.payload, resolveWorkerRuntimeSettings(config, command.payload))
					.then((completion) =>
						complete({
							kind: "bootstrap_succeeded",
							startRecordId: command.startRecordId,
							completion,
						}),
					)
					.catch((error) =>
						complete({
							kind: "bootstrap_failed",
							startRecordId: command.startRecordId,
							error,
							payload: command.payload,
						}),
					);
				return;
			case "activate":
				void resources
					.activate(command.startRecordId, command.turnRecordId, command.session)
					.then((result) => {
						if (resources.piHandle) piEvents.attach(resources.piHandle);
						complete({
							kind: "activation_succeeded",
							startRecordId: command.startRecordId,
							turnRecordId: command.turnRecordId,
							...result,
						});
					})
					.catch((error) =>
						complete({
							kind: "activation_failed",
							startRecordId: command.startRecordId,
							turnRecordId: command.turnRecordId,
							error,
						}),
					);
				return;
			case "deliver_inputs": {
				const handle = resources.piHandle;
				if (!handle) {
					complete({
						kind: "input_delivery_failed",
						headSequence: command.headSequence,
						error: new Error("Input delivery requires an active Pi handle"),
					});
					return;
				}
				void deliverBatch(handle, [...command.inputs], command.piTurnActive)
					.then((delivered) => {
						const prompted = delivered.some((item) => item.deliveryMode === "prompt");
						complete({
							kind: "inputs_delivered",
							headSequence: command.headSequence,
							delivered,
							...(prompted
								? {
										meta: {
											currentPrimaryPathLeafId: handle.getLeafId(),
											rootEntryId: resolveRootEntryIdFromHandle(handle),
										},
									}
								: {}),
						});
					})
					.catch((error) =>
						complete({ kind: "input_delivery_failed", headSequence: command.headSequence, error }),
					);
				return;
			}
			case "execute_turn":
				void resources
					.runTurn((signal) =>
						executeSelectedTurn({
							session: command.session,
							requestQuestions: (request) => questionBridge.request(request),
							integrationTools: integrationToolBridge.createTools(
								command.session.integrationTools,
								command.turnRecordId,
							),
							piHandle: resources.piHandle,
							turnRecordId: command.turnRecordId,
							targetedInputs: command.targetedInputs,
							scheduler: adapters.scheduler,
							resultImageTools: adapters.resultImageTools,
							signal,
							emit(emission) {
								if (emission.kind === "session_tainted") {
									complete({ kind: "session_tainted", reason: emission.reason });
								} else if (emission.kind === "trace") {
									reporter.workerTrace(emission.payload, command.session.selectedTurnId);
								} else if (emission.kind === "progress") {
									reporter.workerEvent(
										"turn.progress",
										{ turnRecordId: emission.turnRecordId, report: emission.report },
										command.session.selectedTurnId,
									);
								} else if (emission.kind === "prepared") {
									reporter.workerEvent(
										"turn.prepared",
										{ turnRecordId: emission.turnRecordId, data: emission.data },
										command.session.selectedTurnId,
									);
								} else reporter.workerError(emission.payload, command.session.selectedTurnId);
							},
						}),
					)
					.then((result) =>
						complete({ kind: "turn_completed", turnRecordId: command.turnRecordId, result }),
					)
					.catch((error) =>
						complete({ kind: "turn_defect", turnRecordId: command.turnRecordId, error }),
					);
				return;
			case "upload_snapshot":
				void resources
					.uploadSnapshot(command.source, command.point, {
						turnRecordId: command.turnRecordId,
						required: command.required,
					})
					.then(() =>
						complete({
							kind: "snapshot_succeeded",
							point: command.point,
							turnRecordId: command.turnRecordId,
						}),
					)
					.catch((error) =>
						complete({
							kind: "snapshot_failed",
							point: command.point,
							turnRecordId: command.turnRecordId,
							error,
						}),
					);
				return;
			case "sample_credentials":
				void sampleCredentials(command.descriptor)
					.then((sample) =>
						complete({
							kind: "credential_sampled",
							providerId: command.descriptor.providerId,
							...sample,
						}),
					)
					.catch((error) =>
						complete({
							kind: "credential_sample_failed",
							providerId: command.descriptor.providerId,
							error,
						}),
					);
				return;
			case "cleanup":
				void resources
					.cleanup()
					.then(() => complete({ kind: "cleanup_succeeded" }))
					.catch((error) => complete({ kind: "cleanup_failed", error }));
		}
	};

	const processOutput = (output: WorkerRuntimeOutput): void => {
		if (output.kind === "protocol") {
			reporter.project(output);
			return;
		}
		if (output.kind === "extension") {
			const payload =
				output.event === "worker.handle_ready"
					? {
							instanceId: config.instanceId,
							workerId: config.workerId,
							...(output.payload as object),
						}
					: output.payload;
			adapters.extensionEvents?.emit(output.event, payload);
			return;
		}
		if (output.kind === "diagnostic") {
			reporter.workerTrace(output.payload, state.session?.selectedTurnId ?? null);
			if (output.stderr) adapters.stderr?.write(`${output.stderr}\n`);
			return;
		}
		if (output.kind === "stderr") {
			adapters.stderr?.write(`${output.message}\n`);
			return;
		}
		launch(output);
	};

	function drain(): void {
		if (draining) return;
		draining = true;
		try {
			while (queue.length > 0) {
				const event = queue.shift();
				if (!event) continue;
				if (event.kind === "invariant_failed") invariantQueued = false;
				let reduction: ReturnType<typeof reduceWorkerRuntime>;
				try {
					reduction = reduceWorkerRuntime(state, event);
				} catch (error) {
					invariant(error);
					continue;
				}
				state = reduction.state;
				for (const output of reduction.outputs) {
					try {
						processOutput(output);
					} catch (error) {
						invariant(error);
						break;
					}
				}
			}
		} finally {
			draining = false;
			if (queue.length > 0) drain();
		}
	}

	dispatch = (event) => {
		queue.push(event);
		drain();
	};

	const receive = (message: ServerToWorkerMessage): void => {
		if (message.type === "worker.integration_tool_result") {
			integrationToolBridge.handle(message);
			return;
		}
		if (message.type === "worker.question_response") {
			questionBridge.handle(message);
			return;
		}
		if (message.type === "worker.abort_turn") {
			if (!resources.abortActiveTurn()) void resources.abortTurn();
			dispatch({ kind: "operator_abort_observed" });
			return;
		}
		if (message.type === "worker.stop") resources.abortToolPreparation();
		dispatch({ kind: "server_message", message });
	};

	return {
		async start() {
			if (started) throw new Error("Worker runtime already started");
			started = true;
			ipc.onMessage(receive);
			ipc.onError((error) => dispatch({ kind: "transport_failed", error }));
			ipc.onConnect?.(() => {
				dispatch({ kind: "transport_connected" });
				questionBridge.replay();
				integrationToolBridge.replay();
			});
			ipc.start();
			dispatch({ kind: "runtime_started" });
		},
		async stop(reason: string) {
			if (state.phase.kind === "exited") return;
			questionBridge.cancelAll(`Question request cancelled: ${reason}`);
			integrationToolBridge.cancelAll(`Integration tool request cancelled: ${reason}`);
			dispatch({ kind: "stop_requested", reason, exitAfterCleanup: false });
			await closed;
		},
	};
}
