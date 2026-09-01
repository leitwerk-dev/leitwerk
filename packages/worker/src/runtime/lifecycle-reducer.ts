import {
	type ServerToWorkerMessage,
	WORKER_API_VERSION,
	type WorkerStartPayload,
	type WorkerToServerMessage,
} from "@leitwerk-dev/worker-protocol";
import type { WorkerDiagnosticPayload } from "../diagnostics.js";
import type { DeliveredInput, InputItem, TargetedInputItem } from "../input-consumer.js";
import type { WorkerProtocolFact } from "../worker-ipc-reporter.js";
import { inputDeliveryToItem } from "../worker-payloads.js";
import type {
	CredentialRefreshDescriptor,
	PreparedWorkerSession,
	WorkerBootstrapCompletion,
} from "./bootstrap-session.js";
import {
	normalizeWorkerFailure,
	type WorkerFailure,
	type WorkerTurnFailureCorrelation,
} from "./failure-policy.js";
import { resolveWorkerSnapshotPolicy, type WorkerSnapshotPoint } from "./snapshot-policy.js";
import type { AppliedTargetedInput, SelectedTurnExecutionResult } from "./turn-execution.js";

export type WorkerRuntimeStateName =
	| "init"
	| "waiting_for_start"
	| "bootstrapping"
	| "idle"
	| "busy"
	| "draining"
	| "cleanup"
	| "exited";
/** Compatibility type used by pure failure normalization. */
export type WorkerRuntimeState = WorkerRuntimeStateName;
export type ReportedWorkerState = "idle" | "busy" | "draining";
export type WorkerTimerName = "heartbeat" | "acceptance_retry" | "credential_poll" | "terminal_ack";

type ActiveTurnStatus = "pending" | "executing" | "completed";
type DrainingOperation =
	| { kind: "bootstrap"; startRecordId: string; proposedTurnRecordId: string }
	| { kind: "activation"; startRecordId: string; turnRecordId: string }
	| { kind: "turn"; turnRecordId: string }
	| null;
export type WorkerRuntimePhase =
	| { kind: "init" }
	| { kind: "waiting_for_start" }
	| { kind: "bootstrapping"; startRecordId: string; proposedTurnRecordId: string }
	| {
			kind: "readying";
			startRecordId: string;
			proposedTurnRecordId: string;
			acceptedId: string | null;
	  }
	| { kind: "waiting_for_acceptance"; startRecordId: string; proposedTurnRecordId: string }
	| { kind: "activating"; startRecordId: string; turnRecordId: string }
	| { kind: "active"; startRecordId: string; turnRecordId: string; turnStatus: ActiveTurnStatus }
	| {
			kind: "draining";
			reason: string;
			exitAfterCleanup: boolean;
			operation: DrainingOperation;
	  }
	| {
			kind: "cleaning";
			reason: string;
			exitAfterCleanup: boolean;
			stage: "publication" | "resources";
	  }
	| { kind: "exited" };

interface CredentialState {
	descriptor: CredentialRefreshDescriptor;
	baselineFingerprint: string | null;
	pendingFingerprint: string | null;
	revision: number;
	sampling: boolean;
	updatePending: boolean;
	enabled: boolean;
}

interface PendingTerminal {
	fact: WorkerProtocolFact<"worker.turn_outcome"> | WorkerProtocolFact<"worker.turn_failed">;
	park: Extract<WorkerToServerMessage, { type: "worker.lifecycle_parked" }>["payload"] | null;
	correlation: WorkerTurnFailureCorrelation;
}

interface PendingFatal {
	payload: Extract<WorkerToServerMessage, { type: "worker.failed" }>["payload"];
	exitCode?: number;
}

type PublicationState =
	| { kind: "none" }
	| {
			kind: "ready_snapshot";
			snapshot: {
				point: "after_worker_ready";
				turnRecordId: null;
				required: false;
			};
	  }
	| {
			kind: "terminal_snapshot";
			snapshot: {
				point: "before_turn_outcome" | "before_turn_failed";
				turnRecordId: string;
				required: true;
			};
			terminal: PendingTerminal;
	  }
	| {
			kind: "terminal_pending_ack";
			terminal: PendingTerminal;
	  }
	| {
			kind: "cleanup_snapshot";
			snapshot: {
				point: "before_cleanup_completed";
				turnRecordId: null;
				required: true;
			};
	  }
	| {
			kind: "fatal_snapshot";
			snapshot: {
				point: "before_worker_failed";
				turnRecordId: null;
				required: false;
			};
			fatal: PendingFatal;
			afterSnapshot: "exit" | "cleanup";
	  }
	| { kind: "fatal_pending_cleanup"; fatal: PendingFatal };

interface ActiveWork {
	deliveryHeadSequence: number | null;
	publication: PublicationState;
}

export interface WorkerRuntimeStateMachine {
	phase: WorkerRuntimePhase;
	session: PreparedWorkerSession | null;
	inputQueue: readonly InputItem[];
	lastSequenceConsumed: number;
	sessionTainted: boolean;
	piTurnActive: boolean;
	work: ActiveWork;
	credential: CredentialState | null;
	timers: Record<WorkerTimerName, string | null>;
}

export type WorkerExtensionFact = {
	kind: "extension";
	event: "worker.handle_ready" | "worker.session_tainted";
	payload: unknown;
};
export type WorkerDiagnosticFact = {
	kind: "diagnostic";
	payload: WorkerDiagnosticPayload;
	stderr?: string;
};
export type WorkerStderrFact = { kind: "stderr"; message: string };
export interface WorkerSnapshotSource {
	kind: "automatic" | "llm";
	treeFile: string;
}

export type WorkerRuntimeCommand =
	| { kind: "bootstrap"; startRecordId: string; payload: WorkerStartPayload }
	| {
			kind: "activate";
			startRecordId: string;
			turnRecordId: string;
			session: PreparedWorkerSession;
	  }
	| {
			kind: "deliver_inputs";
			headSequence: number;
			inputs: readonly InputItem[];
			piTurnActive: boolean;
	  }
	| {
			kind: "execute_turn";
			turnRecordId: string;
			targetedInputs: readonly TargetedInputItem[];
			session: PreparedWorkerSession;
	  }
	| {
			kind: "upload_snapshot";
			point: WorkerSnapshotPoint;
			turnRecordId: string | null;
			required: boolean;
			source: WorkerSnapshotSource;
	  }
	| { kind: "sample_credentials"; descriptor: CredentialRefreshDescriptor; baseline: boolean }
	| { kind: "cleanup" }
	| { kind: "arm_timer"; name: WorkerTimerName; delayMs: number; correlation: string }
	| { kind: "cancel_timer"; name: WorkerTimerName }
	| { kind: "close_transport" }
	| { kind: "exit"; code: number };

export type WorkerRuntimeOutput =
	| WorkerProtocolFact
	| WorkerExtensionFact
	| WorkerDiagnosticFact
	| WorkerStderrFact
	| WorkerRuntimeCommand;

export type WorkerRuntimeEvent =
	| { kind: "runtime_started" }
	| { kind: "transport_connected" }
	| { kind: "transport_failed"; error: Error }
	| { kind: "server_message"; message: ServerToWorkerMessage }
	| { kind: "stop_requested"; reason: string; exitAfterCleanup: boolean }
	| { kind: "operator_abort_observed" }
	| { kind: "pi_turn_started" }
	| { kind: "pi_turn_ended" }
	| { kind: "session_tainted"; reason: string }
	| { kind: "timer_fired"; name: WorkerTimerName; correlation: string }
	| { kind: "bootstrap_succeeded"; startRecordId: string; completion: WorkerBootstrapCompletion }
	| {
			kind: "bootstrap_failed";
			startRecordId: string;
			error: unknown;
			payload: WorkerStartPayload;
	  }
	| {
			kind: "activation_succeeded";
			startRecordId: string;
			turnRecordId: string;
			diagnostics: readonly string[];
	  }
	| { kind: "activation_failed"; startRecordId: string; turnRecordId: string; error: unknown }
	| {
			kind: "inputs_delivered";
			headSequence: number;
			delivered: readonly DeliveredInput[];
			meta?: { currentPrimaryPathLeafId?: string | null; rootEntryId?: string | null };
	  }
	| { kind: "input_delivery_failed"; headSequence: number; error: unknown }
	| { kind: "turn_completed"; turnRecordId: string; result: SelectedTurnExecutionResult }
	| { kind: "turn_defect"; turnRecordId: string; error: unknown }
	| { kind: "snapshot_succeeded"; point: WorkerSnapshotPoint; turnRecordId: string | null }
	| {
			kind: "snapshot_failed";
			point: WorkerSnapshotPoint;
			turnRecordId: string | null;
			error: unknown;
	  }
	| {
			kind: "credential_sampled";
			providerId: string;
			values: Record<string, string>;
			fingerprint: string;
	  }
	| { kind: "credential_sample_failed"; providerId: string; error: unknown }
	| { kind: "cleanup_succeeded" }
	| { kind: "cleanup_failed"; error: unknown }
	| { kind: "invariant_failed"; error: unknown };

export interface WorkerRuntimeReduction {
	state: WorkerRuntimeStateMachine;
	outputs: readonly WorkerRuntimeOutput[];
}

const HELLO = {
	kind: "protocol",
	type: "worker.hello",
	payload: {
		version: "0.1.0",
		apiVersion: WORKER_API_VERSION,
		capabilities: ["worker.ipc/v1", "input.batch", "worker.stop", "worker.abort_turn"],
	},
} as unknown as WorkerProtocolFact<"worker.hello">;

export function createInitialWorkerRuntimeState(): WorkerRuntimeStateMachine {
	return {
		phase: { kind: "init" },
		session: null,
		inputQueue: [],
		lastSequenceConsumed: 0,
		sessionTainted: false,
		piTurnActive: false,
		work: {
			deliveryHeadSequence: null,
			publication: { kind: "none" },
		},
		credential: null,
		timers: {
			heartbeat: null,
			acceptance_retry: null,
			credential_poll: null,
			terminal_ack: null,
		},
	};
}

export function deriveReportedWorkerState(state: WorkerRuntimeStateMachine): ReportedWorkerState {
	if (state.phase.kind === "draining" || state.phase.kind === "cleaning") return "draining";
	if (
		(state.phase.kind === "active" &&
			(state.phase.turnStatus === "executing" ||
				state.work.publication.kind === "terminal_snapshot" ||
				state.work.publication.kind === "terminal_pending_ack")) ||
		state.work.deliveryHeadSequence !== null
	)
		return "busy";
	return "idle";
}

export type WorkerInputEffect =
	| { kind: "none" }
	| { kind: "blocked"; reason: "session_tainted" }
	| { kind: "deliver"; inputs: readonly InputItem[] }
	| { kind: "consume_ignored"; inputs: readonly InputItem[] }
	| { kind: "start_turn"; inputs: readonly TargetedInputItem[] };

/** Pure FIFO policy. Queue storage remains reducer-owned. */
export function decideWorkerInputEffect(input: {
	items: readonly InputItem[];
	sessionTainted: boolean;
	piAvailable: boolean;
	mayStartTurn: boolean;
}): WorkerInputEffect {
	const head = input.items[0];
	if (!head)
		return input.mayStartTurn && !input.sessionTainted
			? { kind: "start_turn", inputs: [] }
			: { kind: "none" };
	if (input.sessionTainted) return { kind: "blocked", reason: "session_tainted" };
	if (head.target) {
		if (!input.mayStartTurn) return { kind: "none" };
		const targeted: TargetedInputItem[] = [];
		for (const item of input.items) {
			if (!item.target) break;
			targeted.push(item as TargetedInputItem);
		}
		return { kind: "start_turn", inputs: targeted };
	}
	const ordinary: InputItem[] = [];
	for (const item of input.items) {
		if (item.target) break;
		ordinary.push(item);
	}
	return input.piAvailable
		? { kind: "deliver", inputs: ordinary }
		: { kind: "consume_ignored", inputs: ordinary };
}

function enqueueInputs(
	current: readonly InputItem[],
	incoming: readonly InputItem[],
): readonly InputItem[] {
	const byId = new Map(current.map((item) => [item.inputId, item]));
	for (const item of incoming) byId.set(item.inputId, item);
	return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
}

function protocol<T extends WorkerToServerMessage["type"]>(
	type: T,
	payload: Extract<WorkerToServerMessage, { type: T }>["payload"],
): WorkerProtocolFact<T> {
	return { kind: "protocol", type, payload } as unknown as WorkerProtocolFact<T>;
}

function currentStateName(state: WorkerRuntimeStateMachine): WorkerRuntimeStateName {
	switch (state.phase.kind) {
		case "readying":
		case "waiting_for_acceptance":
			return "idle";
		case "activating":
			return "busy";
		case "active":
			return state.phase.turnStatus === "executing" ||
				state.work.publication.kind === "terminal_snapshot"
				? "busy"
				: "idle";
		case "cleaning":
			return "cleanup";
		default:
			return state.phase.kind;
	}
}

function failureContext(state: WorkerRuntimeStateMachine) {
	return state.session
		? {
				selectedTurnId: state.session.selectedTurnId,
				lifecycleStatus: state.session.processSnapshot.lifecycleStatus,
				snapshotSource: sessionSnapshotSource(state.session),
			}
		: null;
}

function sessionSnapshotSource(session: PreparedWorkerSession): WorkerSnapshotSource {
	return {
		kind: session.kind,
		treeFile: session.treeFile,
	};
}

type SnapshotCompletionEvent = {
	point: WorkerSnapshotPoint;
	turnRecordId: string | null;
};

function snapshotMatches(
	snapshot: { point: WorkerSnapshotPoint; turnRecordId: string | null },
	event: SnapshotCompletionEvent,
): boolean {
	return snapshot.point === event.point && snapshot.turnRecordId === event.turnRecordId;
}

function hasActivePublication(state: WorkerRuntimeStateMachine): boolean {
	return state.work.publication.kind !== "none";
}

function requireNoPublication(state: WorkerRuntimeStateMachine): void {
	if (hasActivePublication(state)) throw new Error("Snapshot publication is already active");
}

function beginReadySnapshot(
	state: WorkerRuntimeStateMachine,
	source: WorkerSnapshotSource,
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeStateMachine {
	requireNoPublication(state);
	const snapshot = {
		point: "after_worker_ready" as const,
		turnRecordId: null,
		required: false as const,
	};
	outputs.push({ kind: "upload_snapshot", ...snapshot, source });
	return {
		...state,
		work: { ...state.work, publication: { kind: "ready_snapshot", snapshot } },
	};
}

function beginTerminalSnapshot(
	state: WorkerRuntimeStateMachine,
	point: "before_turn_outcome" | "before_turn_failed",
	turnRecordId: string,
	terminal: PendingTerminal,
	source: WorkerSnapshotSource,
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeStateMachine {
	requireNoPublication(state);
	const snapshot = { point, turnRecordId, required: true as const };
	outputs.push({ kind: "upload_snapshot", ...snapshot, source });
	return {
		...state,
		work: {
			...state.work,
			publication: { kind: "terminal_snapshot", snapshot, terminal },
		},
	};
}

const TERMINAL_ACK_RETRY_MS = 5_000;

function publishTerminalAndAwaitAcknowledgement(
	state: WorkerRuntimeStateMachine,
	terminal: PendingTerminal,
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeStateMachine {
	outputs.push(terminal.fact);
	if (terminal.park) outputs.push(protocol("worker.lifecycle_parked", terminal.park));
	return armTimer(
		{
			...state,
			work: {
				...state.work,
				publication: { kind: "terminal_pending_ack", terminal },
			},
		},
		outputs,
		"terminal_ack",
		TERMINAL_ACK_RETRY_MS,
		terminal.correlation.turnRecordId,
	);
}

function beginCleanupSnapshot(
	state: WorkerRuntimeStateMachine,
	source: WorkerSnapshotSource,
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeStateMachine {
	requireNoPublication(state);
	const snapshot = {
		point: "before_cleanup_completed" as const,
		turnRecordId: null,
		required: true as const,
	};
	outputs.push({ kind: "upload_snapshot", ...snapshot, source });
	return {
		...state,
		work: { ...state.work, publication: { kind: "cleanup_snapshot", snapshot } },
	};
}

function beginFatalSnapshot(
	state: WorkerRuntimeStateMachine,
	fatal: PendingFatal,
	source: WorkerSnapshotSource,
	afterSnapshot: "exit" | "cleanup",
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeStateMachine {
	requireNoPublication(state);
	const snapshot = {
		point: "before_worker_failed" as const,
		turnRecordId: null,
		required: false as const,
	};
	outputs.push({ kind: "upload_snapshot", ...snapshot, source });
	return {
		...state,
		work: {
			...state.work,
			publication: { kind: "fatal_snapshot", snapshot, fatal, afterSnapshot },
		},
	};
}

function finishFatal(
	state: WorkerRuntimeStateMachine,
	fatal: PendingFatal,
): { state: WorkerRuntimeStateMachine; outputs: WorkerRuntimeOutput[] } {
	const outputs: WorkerRuntimeOutput[] = [
		protocol("worker.failed", fatal.payload),
		{ kind: "close_transport" },
	];
	if (fatal.exitCode !== undefined) outputs.push({ kind: "exit", code: fatal.exitCode });
	return {
		state: {
			...state,
			work: { ...state.work, publication: { kind: "none" } },
			phase: { kind: "exited" },
		},
		outputs,
	};
}

function failureOutputs(
	state: WorkerRuntimeStateMachine,
	failure: WorkerFailure,
): { state: WorkerRuntimeStateMachine; outputs: WorkerRuntimeOutput[] } {
	const disposition = normalizeWorkerFailure(failure);
	const outputs: WorkerRuntimeOutput[] = [];
	if (disposition.diagnostic)
		outputs.push({
			kind: "diagnostic",
			payload: disposition.diagnostic,
		});
	if (disposition.stderrMessage)
		outputs.push({ kind: "stderr", message: disposition.stderrMessage });
	let next = state;
	switch (disposition.terminal.kind) {
		case "turn_failed":
			outputs.push(protocol("worker.turn_failed", disposition.terminal.payload));
			outputs.push(protocol("worker.lifecycle_parked", disposition.terminal.park));
			break;
		case "park":
			outputs.push(protocol("worker.lifecycle_parked", disposition.terminal.payload));
			break;
		case "worker_failed": {
			const fatal = {
				payload: disposition.terminal.payload,
				...(disposition.exitCode === undefined ? {} : { exitCode: disposition.exitCode }),
			};
			if (disposition.snapshot && !hasActivePublication(state)) {
				const afterSnapshot =
					state.phase.kind === "cleaning" && state.phase.stage === "publication"
						? "cleanup"
						: "exit";
				next = beginFatalSnapshot(next, fatal, disposition.snapshot.source, afterSnapshot, outputs);
				break;
			}
			const finished = finishFatal(next, fatal);
			next = finished.state;
			outputs.push(...finished.outputs);
			break;
		}
		case "transport_lost":
			next = {
				...next,
				work: { ...next.work, publication: { kind: "none" } },
				phase: { kind: "exited" },
			};
			outputs.push({ kind: "close_transport" }, { kind: "exit", code: disposition.exitCode ?? 1 });
			break;
	}
	return { state: next, outputs };
}

function matchesBootstrap(state: WorkerRuntimeStateMachine, startRecordId: string): boolean {
	return (
		(state.phase.kind === "bootstrapping" && state.phase.startRecordId === startRecordId) ||
		(state.phase.kind === "draining" &&
			state.phase.operation?.kind === "bootstrap" &&
			state.phase.operation.startRecordId === startRecordId)
	);
}

function matchesActivation(
	state: WorkerRuntimeStateMachine,
	startRecordId: string,
	turnRecordId: string,
): boolean {
	if (state.phase.kind === "activating") {
		return state.phase.startRecordId === startRecordId && state.phase.turnRecordId === turnRecordId;
	}
	const operation = state.phase.kind === "draining" ? state.phase.operation : null;
	return (
		operation?.kind === "activation" &&
		operation.startRecordId === startRecordId &&
		operation.turnRecordId === turnRecordId
	);
}

function matchesTurn(state: WorkerRuntimeStateMachine, turnRecordId: string): boolean {
	if (state.phase.kind === "active") {
		return state.phase.turnStatus === "executing" && state.phase.turnRecordId === turnRecordId;
	}
	return (
		state.phase.kind === "draining" &&
		state.phase.operation?.kind === "turn" &&
		state.phase.operation.turnRecordId === turnRecordId
	);
}

function finishDrainingOperation(state: WorkerRuntimeStateMachine): WorkerRuntimeStateMachine {
	return state.phase.kind === "draining"
		? { ...state, phase: { ...state.phase, operation: null } }
		: state;
}

function noActiveWork(state: WorkerRuntimeStateMachine): boolean {
	return (
		state.phase.kind === "draining" &&
		state.phase.operation === null &&
		state.work.deliveryHeadSequence === null &&
		state.work.publication.kind === "none"
	);
}

function inputConsumedFact(
	item: { inputId: string; sequence: number },
	deliveryMode: string,
	meta: Record<string, unknown> = {},
): WorkerProtocolFact<"worker.input_consumed"> {
	return protocol("worker.input_consumed", {
		inputId: item.inputId,
		sequence: item.sequence,
		deliveryMode,
		...meta,
	} as never);
}

function removeAppliedTargeted(
	state: WorkerRuntimeStateMachine,
	applied: readonly AppliedTargetedInput[],
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeStateMachine {
	const queue = [...state.inputQueue];
	let last = state.lastSequenceConsumed;
	for (const item of applied) {
		const head = queue[0];
		if (!head || head.inputId !== item.inputId || head.sequence !== item.sequence || !head.target)
			break;
		queue.shift();
		last = Math.max(last, item.sequence);
		outputs.push(inputConsumedFact(item, "append_message", item.meta ?? {}));
	}
	return { ...state, inputQueue: queue, lastSequenceConsumed: last };
}

function armTimer(
	state: WorkerRuntimeStateMachine,
	outputs: WorkerRuntimeOutput[],
	name: WorkerTimerName,
	delayMs: number,
	correlation: string,
): WorkerRuntimeStateMachine {
	outputs.push({ kind: "arm_timer", name, delayMs, correlation });
	return { ...state, timers: { ...state.timers, [name]: correlation } };
}

function beginActivation(
	state: WorkerRuntimeStateMachine,
	startRecordId: string,
	turnRecordId: string,
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeStateMachine {
	if (!state.session) return state;
	outputs.push({ kind: "cancel_timer", name: "acceptance_retry" });
	outputs.push({ kind: "activate", startRecordId, turnRecordId, session: state.session });
	return {
		...state,
		phase: { kind: "activating", startRecordId, turnRecordId },
		timers: { ...state.timers, acceptance_retry: null },
	};
}

function finishReadying(
	state: WorkerRuntimeStateMachine,
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeStateMachine {
	if (state.phase.kind !== "readying" || state.credential?.sampling) return state;
	const readying = state.phase;
	const next = state;
	if (hasActivePublication(next)) return next;
	const { startRecordId, proposedTurnRecordId, acceptedId } = readying;
	if (acceptedId) return beginActivation(next, startRecordId, acceptedId, outputs);
	outputs.push(protocol("worker.turn_started", { startRecordId, proposedTurnRecordId }));
	return armTimer(
		{ ...next, phase: { kind: "waiting_for_acceptance", startRecordId, proposedTurnRecordId } },
		outputs,
		"acceptance_retry",
		1_000,
		startRecordId,
	);
}

function advance(
	state: WorkerRuntimeStateMachine,
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeStateMachine {
	let next = finishReadying(state, outputs);
	if (next.phase.kind === "draining" && noActiveWork(next)) {
		const { reason, exitAfterCleanup } = next.phase;
		outputs.push(protocol("worker.cleanup_started", { reason }));
		const cleanupSnapshot = next.session
			? resolveWorkerSnapshotPolicy(
					"before_cleanup_completed",
					next.session.kind,
					next.session.piAvailable,
				)
			: { upload: false as const };
		if (cleanupSnapshot.upload && next.session) {
			next = beginCleanupSnapshot(
				{
					...next,
					phase: { kind: "cleaning", reason, exitAfterCleanup, stage: "publication" },
				},
				sessionSnapshotSource(next.session),
				outputs,
			);
		} else {
			outputs.push({ kind: "cleanup" });
			next = {
				...next,
				phase: { kind: "cleaning", reason, exitAfterCleanup, stage: "resources" },
			};
		}
		return next;
	}
	if (
		(next.phase.kind !== "active" && next.phase.kind !== "waiting_for_acceptance") ||
		next.work.deliveryHeadSequence !== null ||
		hasActivePublication(next)
	)
		return next;
	const mayStartTurn = next.phase.kind === "active" && next.phase.turnStatus === "pending";
	if (next.phase.kind === "waiting_for_acceptance" && next.session?.kind === "llm") return next;
	const decision = decideWorkerInputEffect({
		items: next.inputQueue,
		sessionTainted: next.sessionTainted,
		piAvailable: next.session?.piAvailable ?? false,
		mayStartTurn,
	});
	if (decision.kind === "blocked") {
		outputs.push({
			kind: "diagnostic",
			payload: {
				level: "warn",
				code: "input.skipped_session_tainted",
				message: "Skipping queued inputs because the Pi session is tainted",
				details: { skippedInputCount: next.inputQueue.length },
			},
		});
		return next;
	}
	if (decision.kind === "consume_ignored") {
		const ids = new Set(decision.inputs.map((item) => item.inputId));
		for (const item of decision.inputs) outputs.push(inputConsumedFact(item, "ignored"));
		next = {
			...next,
			inputQueue: next.inputQueue.filter((item) => !ids.has(item.inputId)),
			lastSequenceConsumed: Math.max(
				next.lastSequenceConsumed,
				...decision.inputs.map((item) => item.sequence),
			),
		};
		return advance(next, outputs);
	}
	if (decision.kind === "deliver") {
		const headSequence = decision.inputs[0].sequence;
		outputs.push({
			kind: "deliver_inputs",
			headSequence,
			inputs: decision.inputs,
			piTurnActive: next.piTurnActive,
		});
		return { ...next, work: { ...next.work, deliveryHeadSequence: headSequence } };
	}
	if (decision.kind === "start_turn" && next.session && next.phase.kind === "active") {
		outputs.push({
			kind: "execute_turn",
			turnRecordId: next.phase.turnRecordId,
			targetedInputs: decision.inputs,
			session: next.session,
		});
		return {
			...next,
			phase: { ...next.phase, turnStatus: "executing" },
		};
	}
	return next;
}

function withReportedTransition(
	previous: WorkerRuntimeStateMachine,
	next: WorkerRuntimeStateMachine,
	event: WorkerRuntimeEvent,
	outputs: WorkerRuntimeOutput[],
): WorkerRuntimeReduction {
	const from = deriveReportedWorkerState(previous);
	const to = deriveReportedWorkerState(next);
	if (from !== to && next.phase.kind !== "exited") {
		outputs.push(protocol("worker.state", { from, to, reason: event.kind }));
	}
	return { state: next, outputs };
}

/** The sole pure owner of worker lifecycle decisions and canonical facts. */
export function reduceWorkerRuntime(
	state: WorkerRuntimeStateMachine,
	event: WorkerRuntimeEvent,
): WorkerRuntimeReduction {
	let next = state;
	const outputs: WorkerRuntimeOutput[] = [];

	if (state.phase.kind === "exited" && event.kind !== "runtime_started") return { state, outputs };

	switch (event.kind) {
		case "runtime_started":
			if (state.phase.kind !== "init") break;
			next = { ...state, phase: { kind: "waiting_for_start" } };
			outputs.push(HELLO);
			outputs.push(protocol("worker.bootstrap_progress", { phase: "worker_connected" }));
			break;
		case "transport_connected":
			outputs.push(HELLO);
			outputs.push(protocol("worker.bootstrap_progress", { phase: "worker_connected" }));
			if (state.session) {
				outputs.push(
					protocol("worker.heartbeat", {
						state: deriveReportedWorkerState(state),
						lastSequenceConsumed: state.lastSequenceConsumed,
						currentSelectedTurnId: state.session.selectedTurnId,
					}),
				);
			}
			if (state.work.publication.kind === "terminal_pending_ack") {
				next = publishTerminalAndAwaitAcknowledgement(
					state,
					state.work.publication.terminal,
					outputs,
				);
			}
			break;
		case "transport_failed": {
			const failed = failureOutputs(state, { kind: "transport", error: event.error });
			next = failed.state;
			outputs.push(...failed.outputs);
			break;
		}
		case "stop_requested":
			if (state.phase.kind === "cleaning" || state.phase.kind === "draining") break;
			{
				const operation: DrainingOperation =
					state.phase.kind === "bootstrapping"
						? {
								kind: "bootstrap",
								startRecordId: state.phase.startRecordId,
								proposedTurnRecordId: state.phase.proposedTurnRecordId,
							}
						: state.phase.kind === "activating"
							? {
									kind: "activation",
									startRecordId: state.phase.startRecordId,
									turnRecordId: state.phase.turnRecordId,
								}
							: state.phase.kind === "active" && state.phase.turnStatus === "executing"
								? { kind: "turn", turnRecordId: state.phase.turnRecordId }
								: null;
				next = {
					...state,
					phase: {
						kind: "draining",
						reason: event.reason,
						exitAfterCleanup: event.exitAfterCleanup,
						operation,
					},
				};
			}
			for (const name of Object.keys(state.timers) as WorkerTimerName[])
				outputs.push({ kind: "cancel_timer", name });
			next = {
				...next,
				timers: {
					heartbeat: null,
					acceptance_retry: null,
					credential_poll: null,
					terminal_ack: null,
				},
				credential: null,
			};
			break;
		case "operator_abort_observed":
			break;
		case "pi_turn_started":
			next = { ...state, piTurnActive: true };
			break;
		case "pi_turn_ended":
			next = { ...state, piTurnActive: false };
			break;
		case "session_tainted":
			if (!state.sessionTainted) {
				next = { ...state, sessionTainted: true };
				outputs.push({
					kind: "extension",
					event: "worker.session_tainted",
					payload: { reason: event.reason },
				});
			}
			break;
		case "server_message": {
			const message = event.message;
			if (message.type === "worker.stop") {
				return reduceWorkerRuntime(state, {
					kind: "stop_requested",
					reason: message.payload.reason,
					exitAfterCleanup: true,
				});
			}
			if (message.type === "worker.abort_turn") break;
			if (message.type === "worker.start") {
				if (state.phase.kind !== "waiting_for_start") break;
				const startRecordId = message.payload.turnStart.id;
				next = {
					...state,
					phase: {
						kind: "bootstrapping",
						startRecordId,
						proposedTurnRecordId: message.payload.turnStart.proposedTurnRecordId,
					},
					sessionTainted: false,
				};
				outputs.push(protocol("worker.bootstrap_progress", { phase: "preparing_workspace" }));
				outputs.push({ kind: "bootstrap", startRecordId, payload: message.payload });
				break;
			}
			if (message.type === "input.batch") {
				if (state.phase.kind === "waiting_for_start" || state.phase.kind === "init") break;
				const incoming = message.payload.inputs
					.map(inputDeliveryToItem)
					.filter((item) => item.sequence > state.lastSequenceConsumed);
				next = { ...state, inputQueue: enqueueInputs(state.inputQueue, incoming) };
				break;
			}
			if (message.type === "worker.turn_start_accepted") {
				if (
					state.phase.kind === "readying" &&
					message.payload.startRecordId === state.phase.startRecordId
				) {
					next = { ...state, phase: { ...state.phase, acceptedId: message.payload.turnRecordId } };
					break;
				}
				if (
					state.phase.kind !== "waiting_for_acceptance" ||
					message.payload.startRecordId !== state.phase.startRecordId
				)
					break;
				next = beginActivation(
					state,
					message.payload.startRecordId,
					message.payload.turnRecordId,
					outputs,
				);
				break;
			}
			if (message.type === "worker.turn_terminal_recorded") {
				const publication = state.work.publication;
				if (
					publication.kind !== "terminal_pending_ack" ||
					publication.terminal.correlation.turnRecordId !== message.payload.turnRecordId
				)
					break;
				outputs.push({ kind: "cancel_timer", name: "terminal_ack" });
				next = {
					...state,
					work: { ...state.work, publication: { kind: "none" } },
					timers: { ...state.timers, terminal_ack: null },
				};
				break;
			}
			if (message.type === "worker.credential_update_accepted") {
				const credential = state.credential;
				if (
					!credential?.enabled ||
					!credential.updatePending ||
					message.payload.providerId !== credential.descriptor.providerId
				)
					break;
				if (!message.payload.accepted || message.payload.currentRevision === null) {
					next = {
						...state,
						credential: {
							...credential,
							enabled: false,
							updatePending: false,
							pendingFingerprint: null,
						},
					};
					outputs.push({
						kind: "diagnostic",
						payload: {
							level: "warn",
							code: "credential.refresh_rejected",
							message: message.payload.safeReason ?? "Credential refresh was rejected",
						},
						stderr: message.payload.safeReason,
					});
				} else {
					next = {
						...state,
						credential: {
							...credential,
							revision: message.payload.currentRevision,
							baselineFingerprint: credential.pendingFingerprint ?? credential.baselineFingerprint,
							pendingFingerprint: null,
							updatePending: false,
							sampling: true,
						},
					};
					outputs.push({
						kind: "sample_credentials",
						descriptor: credential.descriptor,
						baseline: false,
					});
				}
			}
			break;
		}
		case "bootstrap_succeeded": {
			if (!matchesBootstrap(state, event.startRecordId)) break;
			const completion = event.completion;
			const acceptedId = completion.session.acceptedTurnRecordId;
			const credential = completion.credentialRefresh
				? {
						descriptor: completion.credentialRefresh,
						baselineFingerprint: null,
						pendingFingerprint: null,
						revision: completion.credentialRefresh.revision,
						sampling: true,
						updatePending: false,
						enabled: true,
					}
				: null;
			const wasDraining = state.phase.kind === "draining";
			next = {
				...state,
				phase:
					state.phase.kind === "draining"
						? { ...state.phase, operation: null }
						: {
								kind: "readying",
								startRecordId: event.startRecordId,
								proposedTurnRecordId: completion.session.proposedTurnRecordId,
								acceptedId,
							},
				session: completion.session,
				inputQueue: enqueueInputs(
					state.inputQueue,
					completion.pendingInputs.filter((item) => item.sequence > state.lastSequenceConsumed),
				),
				credential: wasDraining ? null : credential,
			};
			for (const message of completion.diagnostics)
				outputs.push({
					kind: "diagnostic",
					payload: { level: "warn", code: "bootstrap.diagnostic", message },
				});
			outputs.push(protocol("worker.bootstrap_progress", { phase: "loading_resources" }));
			outputs.push(protocol("worker.bootstrap_progress", { phase: "preparing_turn" }));
			outputs.push(protocol("worker.ready", completion.readyPayload));
			if (wasDraining) break;
			const readySnapshot = resolveWorkerSnapshotPolicy(
				"after_worker_ready",
				completion.session.kind,
				completion.session.piAvailable,
			);
			if (readySnapshot.upload)
				next = beginReadySnapshot(next, sessionSnapshotSource(completion.session), outputs);
			next = armTimer(
				next,
				outputs,
				"heartbeat",
				completion.session.settings.heartbeatIntervalMs,
				event.startRecordId,
			);
			if (completion.credentialRefresh)
				outputs.push({
					kind: "sample_credentials",
					descriptor: completion.credentialRefresh,
					baseline: true,
				});
			break;
		}
		case "bootstrap_failed":
			if (!matchesBootstrap(state, event.startRecordId)) break;
			if (state.phase.kind === "draining") {
				next = finishDrainingOperation(state);
				break;
			}
			{
				const failed = failureOutputs(state, {
					kind: "bootstrap",
					error: event.error,
					payload: event.payload,
				});
				next = failed.state;
				outputs.push(...failed.outputs);
			}
			break;
		case "activation_succeeded":
			if (!matchesActivation(state, event.startRecordId, event.turnRecordId)) break;
			next = {
				...state,
				phase:
					state.phase.kind === "draining"
						? { ...state.phase, operation: null }
						: {
								kind: "active",
								startRecordId: event.startRecordId,
								turnRecordId: event.turnRecordId,
								turnStatus: "pending",
							},
				session:
					state.session?.kind === "llm"
						? {
								...state.session,
								piAvailable: true,
								activeModelProfileId:
									state.session.processSnapshot.selectedTurnModelProfileId ?? null,
							}
						: state.session,
			};
			for (const message of event.diagnostics)
				outputs.push({
					kind: "diagnostic",
					payload: { level: "warn", code: "bootstrap.diagnostic", message },
				});
			if (state.session?.kind === "llm" && state.phase.kind !== "draining")
				outputs.push({
					kind: "extension",
					event: "worker.handle_ready",
					payload: {
						treeFile: state.session.treeFile,
						workspaceRoot: state.session.workspaceRoot,
					},
				});
			break;
		case "activation_failed":
			if (!matchesActivation(state, event.startRecordId, event.turnRecordId)) break;
			if (state.phase.kind === "draining") {
				next = finishDrainingOperation(state);
			} else {
				const failed = failureOutputs(next, {
					kind: "dispatch",
					error: event.error,
					state: "busy",
					session: failureContext(state),
				});
				next = failed.state;
				outputs.push(...failed.outputs);
			}
			break;
		case "inputs_delivered": {
			if (
				state.work.deliveryHeadSequence !== event.headSequence ||
				state.inputQueue[0]?.sequence !== event.headSequence
			)
				break;
			const deliveredIds = new Set(event.delivered.map((item) => item.inputId));
			let last = state.lastSequenceConsumed;
			for (const delivered of event.delivered) {
				last = Math.max(last, delivered.sequence);
				outputs.push(inputConsumedFact(delivered, delivered.deliveryMode, event.meta ?? {}));
			}
			next = {
				...state,
				inputQueue: state.inputQueue.filter((item) => !deliveredIds.has(item.inputId)),
				lastSequenceConsumed: last,
				work: { ...state.work, deliveryHeadSequence: null },
			};
			break;
		}
		case "input_delivery_failed":
			if (state.work.deliveryHeadSequence !== event.headSequence) break;
			next = { ...state, work: { ...state.work, deliveryHeadSequence: null } };
			if (state.phase.kind !== "draining") {
				const failed = failureOutputs(next, {
					kind: "dispatch",
					error: event.error,
					state: currentStateName(state),
					session: failureContext(state),
				});
				next = failed.state;
				outputs.push(...failed.outputs);
			}
			break;
		case "turn_completed": {
			if (!matchesTurn(state, event.turnRecordId)) break;
			next = removeAppliedTargeted(
				finishDrainingOperation(state),
				event.result.appliedTargetedInputs,
				outputs,
			);
			if (event.result.kind === "parked") {
				outputs.push(
					protocol("worker.lifecycle_parked", {
						selectedTurnId: state.session?.selectedTurnId ?? null,
						reason: event.result.reason,
					}),
				);
				next = {
					...next,
					phase:
						state.phase.kind === "active"
							? { ...state.phase, turnStatus: "completed" }
							: next.phase,
				};
				break;
			}
			let pending: PendingTerminal;
			if (event.result.kind === "outcome") {
				pending = {
					fact: protocol("worker.turn_outcome", {
						turnRecordId: event.result.meta.turnRecordId,
						turnId: event.result.turnId,
						turnType: event.result.meta.turnType ?? "llm",
						outcome: event.result.outcome,
						params: event.result.params,
						pathType: event.result.meta.pathType,
						forkPiEntryId: event.result.meta.forkPiEntryId ?? null,
						resultPiEntryId: event.result.meta.resultPiEntryId ?? null,
						turnResultMarkdown: event.result.meta.turnResultMarkdown ?? null,
						rootEntryId: event.result.meta.rootEntryId ?? null,
					} as never),
					park: null,
					correlation: {
						turnRecordId: event.result.meta.turnRecordId,
						turnId: event.result.turnId,
						turnType: event.result.meta.turnType,
						pathType: event.result.meta.pathType,
						forkPiEntryId: event.result.meta.forkPiEntryId,
						resultPiEntryId: event.result.meta.resultPiEntryId,
					},
				};
			} else {
				const disposition = normalizeWorkerFailure({
					kind: "turn",
					error: event.result.failure.failure,
					correlation: event.result.failure,
					session: failureContext(state),
				});
				if (disposition.terminal.kind !== "turn_failed")
					throw new Error("Turn failure policy did not produce a turn failure");
				pending = {
					fact: protocol("worker.turn_failed", disposition.terminal.payload),
					park: disposition.terminal.park,
					correlation: event.result.failure,
				};
			}
			next = {
				...next,
				phase:
					state.phase.kind === "active" ? { ...state.phase, turnStatus: "completed" } : next.phase,
			};
			if (state.session?.kind === "automatic") {
				next = publishTerminalAndAwaitAcknowledgement(next, pending, outputs);
			} else if (state.session) {
				const point =
					event.result.kind === "outcome" ? "before_turn_outcome" : "before_turn_failed";
				const snapshotPolicy = resolveWorkerSnapshotPolicy(
					point,
					state.session.kind,
					state.session.piAvailable,
				);
				if (!snapshotPolicy.upload)
					throw new Error("LLM terminal snapshot policy unexpectedly skipped upload");
				next = beginTerminalSnapshot(
					next,
					point,
					event.turnRecordId,
					pending,
					sessionSnapshotSource(state.session),
					outputs,
				);
			}
			break;
		}
		case "turn_defect":
			if (!matchesTurn(state, event.turnRecordId)) break;
			if (state.phase.kind === "draining") {
				next = finishDrainingOperation(state);
			} else {
				const failed = failureOutputs(next, {
					kind: "dispatch",
					error: event.error,
					state: "busy",
					session: failureContext(state),
				});
				next = failed.state;
				outputs.push(...failed.outputs);
			}
			break;
		case "snapshot_succeeded": {
			const publication = state.work.publication;
			switch (publication.kind) {
				case "none":
				case "terminal_pending_ack":
				case "fatal_pending_cleanup":
					break;
				case "ready_snapshot":
					if (!snapshotMatches(publication.snapshot, event)) break;
					next = { ...state, work: { ...state.work, publication: { kind: "none" } } };
					break;
				case "terminal_snapshot":
					if (!snapshotMatches(publication.snapshot, event)) break;
					next = publishTerminalAndAwaitAcknowledgement(state, publication.terminal, outputs);
					break;
				case "cleanup_snapshot":
					if (!snapshotMatches(publication.snapshot, event)) break;
					if (state.phase.kind !== "cleaning" || state.phase.stage !== "publication")
						throw new Error("Cleanup snapshot completed outside cleanup publication");
					outputs.push({ kind: "cleanup" });
					next = {
						...state,
						phase: { ...state.phase, stage: "resources" },
						work: { ...state.work, publication: { kind: "none" } },
					};
					break;
				case "fatal_snapshot":
					if (!snapshotMatches(publication.snapshot, event)) break;
					if (publication.afterSnapshot === "exit") {
						const finished = finishFatal(state, publication.fatal);
						next = finished.state;
						outputs.push(...finished.outputs);
					} else {
						if (state.phase.kind !== "cleaning" || state.phase.stage !== "publication")
							throw new Error("Fatal snapshot completed outside cleanup publication");
						outputs.push({ kind: "cleanup" });
						next = {
							...state,
							phase: { ...state.phase, stage: "resources" },
							work: {
								...state.work,
								publication: {
									kind: "fatal_pending_cleanup",
									fatal: publication.fatal,
								},
							},
						};
					}
					break;
			}
			break;
		}
		case "snapshot_failed": {
			const publication = state.work.publication;
			switch (publication.kind) {
				case "none":
				case "terminal_pending_ack":
				case "fatal_pending_cleanup":
					break;
				case "ready_snapshot":
					if (!snapshotMatches(publication.snapshot, event)) break;
					next = { ...state, work: { ...state.work, publication: { kind: "none" } } };
					break;
				case "terminal_snapshot": {
					if (!snapshotMatches(publication.snapshot, event)) break;
					const cleared = {
						...state,
						work: { ...state.work, publication: { kind: "none" } as const },
					};
					const failed = failureOutputs(cleared, {
						kind: "mandatory_snapshot",
						error: event.error,
						point: event.point,
						correlation: publication.terminal.correlation,
						session: failureContext(state),
					});
					next = failed.state;
					outputs.push(...failed.outputs);
					break;
				}
				case "cleanup_snapshot": {
					if (!snapshotMatches(publication.snapshot, event)) break;
					if (state.phase.kind !== "cleaning" || state.phase.stage !== "publication")
						throw new Error("Cleanup snapshot failed outside cleanup publication");
					const cleared = {
						...state,
						work: { ...state.work, publication: { kind: "none" } as const },
					};
					const failed = failureOutputs(cleared, {
						kind: "cleanup",
						error: event.error,
						session: failureContext(state),
					});
					next = failed.state;
					outputs.push(...failed.outputs);
					break;
				}
				case "fatal_snapshot":
					if (!snapshotMatches(publication.snapshot, event)) break;
					if (publication.afterSnapshot === "exit") {
						const finished = finishFatal(state, publication.fatal);
						next = finished.state;
						outputs.push(...finished.outputs);
					} else {
						if (state.phase.kind !== "cleaning" || state.phase.stage !== "publication")
							throw new Error("Fatal snapshot failed outside cleanup publication");
						outputs.push({ kind: "cleanup" });
						next = {
							...state,
							phase: { ...state.phase, stage: "resources" },
							work: {
								...state.work,
								publication: {
									kind: "fatal_pending_cleanup",
									fatal: publication.fatal,
								},
							},
						};
					}
					break;
			}
			break;
		}
		case "timer_fired":
			if (state.timers[event.name] !== event.correlation) break;
			next = { ...state, timers: { ...state.timers, [event.name]: null } };
			if (event.name === "heartbeat" && state.session) {
				outputs.push(
					protocol("worker.heartbeat", {
						state: deriveReportedWorkerState(state),
						lastSequenceConsumed: state.lastSequenceConsumed,
						currentSelectedTurnId: state.session.selectedTurnId,
					}),
				);
				next = armTimer(
					next,
					outputs,
					"heartbeat",
					state.session.settings.heartbeatIntervalMs,
					event.correlation,
				);
			} else if (
				event.name === "acceptance_retry" &&
				state.phase.kind === "waiting_for_acceptance"
			) {
				outputs.push(
					protocol("worker.turn_started", {
						startRecordId: state.phase.startRecordId,
						proposedTurnRecordId: state.phase.proposedTurnRecordId,
					}),
				);
				next = armTimer(next, outputs, "acceptance_retry", 1_000, event.correlation);
			} else if (
				event.name === "terminal_ack" &&
				state.work.publication.kind === "terminal_pending_ack" &&
				state.work.publication.terminal.correlation.turnRecordId === event.correlation
			) {
				next = publishTerminalAndAwaitAcknowledgement(
					next,
					state.work.publication.terminal,
					outputs,
				);
			} else if (
				event.name === "credential_poll" &&
				state.credential?.enabled &&
				!state.credential.sampling &&
				!state.credential.updatePending
			) {
				outputs.push({
					kind: "sample_credentials",
					descriptor: state.credential.descriptor,
					baseline: false,
				});
				next = { ...next, credential: { ...state.credential, sampling: true } };
			}
			break;
		case "credential_sampled": {
			const credential = state.credential;
			if (!credential?.sampling || credential.descriptor.providerId !== event.providerId) break;
			if (
				credential.baselineFingerprint === null ||
				credential.baselineFingerprint === event.fingerprint
			) {
				next = armTimer(
					{
						...state,
						credential: {
							...credential,
							baselineFingerprint: credential.baselineFingerprint ?? event.fingerprint,
							sampling: false,
						},
					},
					outputs,
					"credential_poll",
					500,
					event.providerId,
				);
			} else {
				next = {
					...state,
					credential: {
						...credential,
						sampling: false,
						updatePending: true,
						pendingFingerprint: event.fingerprint,
					},
				};
				outputs.push(
					protocol("worker.credential_update", {
						providerId: event.providerId,
						expectedRevision: credential.revision,
						values: event.values,
					}),
				);
			}
			break;
		}
		case "credential_sample_failed":
			if (
				!state.credential?.sampling ||
				state.credential.descriptor.providerId !== event.providerId
			)
				break;
			next = { ...state, credential: { ...state.credential, sampling: false } };
			outputs.push({
				kind: "diagnostic",
				payload: {
					level: "warn",
					code: "credential.refresh_failed",
					message: event.error instanceof Error ? event.error.message : String(event.error),
				},
			});
			next = armTimer(next, outputs, "credential_poll", 500, event.providerId);
			break;
		case "cleanup_succeeded":
			if (state.phase.kind !== "cleaning" || state.phase.stage !== "resources") break;
			if (state.work.publication.kind === "fatal_pending_cleanup") {
				const finished = finishFatal(state, state.work.publication.fatal);
				next = finished.state;
				outputs.push(...finished.outputs);
				break;
			}
			outputs.push(
				protocol("worker.cleanup_completed", { releasedLocks: [], removedTransientPaths: [] }),
			);
			outputs.push({ kind: "close_transport" });
			if (state.phase.exitAfterCleanup) outputs.push({ kind: "exit", code: 0 });
			next = {
				...state,
				phase: { kind: "exited" },
				session: null,
				inputQueue: [],
			};
			break;
		case "cleanup_failed": {
			if (state.phase.kind !== "cleaning" || state.phase.stage !== "resources") break;
			const failed = failureOutputs(state, {
				kind: "cleanup",
				error: event.error,
				session: failureContext(state),
			});
			next = failed.state;
			outputs.push(...failed.outputs);
			break;
		}
		case "invariant_failed": {
			const failed = failureOutputs(state, {
				kind: "dispatch",
				error: event.error,
				state: currentStateName(state),
				session: failureContext(state),
			});
			next = failed.state;
			outputs.push(...failed.outputs);
			break;
		}
	}

	next = advance(next, outputs);
	return withReportedTransition(state, next, event, outputs);
}
