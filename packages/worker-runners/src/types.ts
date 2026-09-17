import type { Readable } from "node:stream";
import type {
	LeitwerkTransferManifestV1,
	SessionTransferLimits,
	SessionTransferPreflight,
	SessionTransferPreflightReport,
} from "@leitwerk-dev/session-transfer";

/**
 * Runner API seams shared by worker run modes (Docker, Kubernetes, best-effort local).
 *
 * The seam is cut so the runtimes share everything except the runtime-specific
 * bodies of two interfaces. The IPC transport is deliberately *not* a runner
 * axis: the runner only injects connect env, the worker dials back over
 * WebSocket, and the existing `WorkerWebSocketIpcManager` binds the socket to
 * the lease. The supervisor stays the lease/lifecycle coordinator; the runner
 * only does runtime-specific work.
 */

/**
 * Durable per-process storage handle.
 *
 * The server NEVER mounts or reads the volume contents. It learns tree and leaf
 * state over the protocol (the session-snapshot exchange), never by reading the
 * volume, which keeps every run mode symmetric.
 */
/** @internal */
export interface VolumeRef {
	/** @internal */
	instanceId: string;
	/** Runtime-specific identifier (host path, named volume, PVC name). */
	/** @internal */
	id: string;
	/** Path inside the worker container where the volume is mounted. */
	/** @internal */
	mountPath: string;
	/** Runtime-specific namespace/project for the volume (Kubernetes process namespace). */
	/** @internal */
	namespace?: string;
}

/** @internal */
export interface ProcessVolumeRequirements {
	/** New Kubernetes PVC capacity. Existing volumes are unchanged; other runners ignore it. */
	/** @internal */
	size?: string;
	/** Select storage compatible with a private Docker daemon. */
	/** @internal */
	docker?: boolean;
}

/** @internal */
export type ProcessStateExportPreflight = SessionTransferPreflight;
/** @internal */
export type ProcessStateExportHelperReport = SessionTransferPreflightReport;

/** Server-owned, credential-scoped relay used by isolated export helpers. */
/** @internal */
export interface ProcessStateExportHelperRelay {
	/** @internal */
	readonly exportId: string;
	/** @internal */
	readonly credential: string;
	/** @internal */
	waitForPreflight(signal?: AbortSignal): Promise<ProcessStateExportHelperReport>;
	/** @internal */
	activateStream(): Readable;
	/** @internal */
	fail(error: Error): void;
}

/** @internal */
export interface PreparedProcessStateExport {
	/** @internal */
	manifest: LeitwerkTransferManifestV1;
	/** @internal */
	preflight: ProcessStateExportPreflight;
	/** @internal */
	stream(input: {
		/** @internal */
		signal?: AbortSignal;
	}): Readable;
}

/** Purpose-specific read-only export seam. It never creates a worker lease. */
/** @internal */
export interface ProcessStateExporter {
	/** @internal */
	prepare(input: {
		/** @internal */
		instanceId: string;
		/** @internal */
		manifest: LeitwerkTransferManifestV1;
		/** @internal */
		limits: SessionTransferLimits;
		/** @internal */
		signal?: AbortSignal;
	}): Promise<PreparedProcessStateExport>;
	/** Removes stale runner-specific export helpers after restart. */
	/** @internal */
	reconcile(): Promise<void>;
}

/** @internal */
export interface ProcessStateExportHelperRelayProvider {
	/** @internal */
	create(input: {
		/** @internal */
		instanceId: string;
		/** @internal */
		manifest: LeitwerkTransferManifestV1;
	}): ProcessStateExportHelperRelay;
}

/** @internal */
export interface ProcessVolume {
	/** Idempotently provisions durable storage for a process instance. */
	/** @internal */
	ensure(
		instanceId: string,
		requirements?: ProcessVolumeRequirements,
		observer?: WorkerStartObserver,
	): Promise<VolumeRef>;
	/** Retention cleanup only. Stopping a worker never calls this. */
	/** @internal */
	release(instanceId: string): Promise<void>;
	/** Permanently deletes every runner-managed resource owned by a deleted process. */
	/** @internal */
	deleteProcessResources(instanceId: string): Promise<void>;
}

/**
 * Output of runtime-profile selection. MVP resolves to a single configured
 * worker image; repository branch content must never select an image.
 */
/** @internal */
export interface ResolvedWorkerImage {
	/** Fully qualified image reference, ideally digest-pinned. */
	/** @internal */
	reference: string;
}

/** @internal */
export interface WorkerResourceLimits {
	/** @internal */
	cpu?: string;
	/** @internal */
	memory?: string;
}

/** @internal */
export interface WorkerUnitRef {
	/** @internal */
	instanceId: string;
	/** @internal */
	workerId: string;
	/** Runtime-specific handle id (container id, pod name). */
	/** @internal */
	unitId: string;
	/** Runtime-specific namespace/project for the unit (Kubernetes process namespace). */
	/** @internal */
	namespace?: string;
}

/** @internal */
export class WorkerStartDiagnosticError extends Error {
	/** @internal */
	readonly publicDiagnostic: string;

	/** @internal */
	constructor(publicDiagnostic: string, cause?: unknown) {
		super("Worker runtime start failed", { cause });
		this.name = "WorkerStartDiagnosticError";
		this.publicDiagnostic = publicDiagnostic;
	}
}

/** @internal */
export interface WorkerExitInfo {
	/** Process exit code when the runtime reports one. */
	/** @internal */
	exitCode: number | null;
	/** Termination signal when the runtime reports one. */
	/** @internal */
	signal: string | null;
	/** True when the runtime killed the unit for exceeding memory limits. */
	/** @internal */
	oomKilled?: boolean;
	/** Human-readable reason surfaced by the runtime, if any. */
	/** @internal */
	reason?: string;
}

/** @internal */
export interface WorkerUnit extends WorkerUnitRef {
	/** Require successful runtime removal before the supervisor permits replacement. */
	/** @internal */
	replacementHandoff?: "stop-before-replacement";
	/** Maps physical worker exit into the supervisor's existing failure paths. */
	/** @internal */
	onExit(listener: (info: WorkerExitInfo) => void): void;
}

/** @internal */
export interface WorkerUnitDescriptor extends WorkerUnitRef {
	/** @internal */
	observedState?: "running" | "pending" | "terminal" | "unknown";
}

/** @internal */
interface StartWorkerInputBase {
	/** @internal */
	instanceId: string;
	/** @internal */
	workerId: string;
	/** @internal */
	serverEpoch: string;
	/** Runtime-profile selection output; MVP = single image. */
	/** @internal */
	image: ResolvedWorkerImage;
	/** Server URL, ids, connect token, `PI_CODING_AGENT_DIR`, etc. */
	/** @internal */
	env: Record<string, string>;
	/** Start the image's private Docker daemon before the worker. */
	/** @internal */
	docker: boolean;
	/** @internal */
	resources?: WorkerResourceLimits;
}

/** Start input for the best-effort local runner, which uses configured host storage. */
/** @internal */
export interface LocalStartWorkerInput extends StartWorkerInputBase {
	/** @internal */
	runnerKind: "local";
	/** @internal */
	volume?: never;
}

/** Start input for isolated runners, whose durable process volume is mandatory. */
/** @internal */
export interface IsolatedStartWorkerInput extends StartWorkerInputBase {
	/** @internal */
	runnerKind: "isolated";
	/** @internal */
	volume: VolumeRef;
}

/** @internal */
export type StartWorkerInput = LocalStartWorkerInput | IsolatedStartWorkerInput;

/** @internal */
export interface StopWorkerOptions {
	/** Grace period before forceful termination. The volume is always kept. */
	/** @internal */
	graceMs: number;
}

/** @internal */
export type WorkerStartPhase = "preparing_runtime" | "allocating_runtime" | "starting_runtime";

/** @internal */
export interface WorkerStartObserver {
	/** @internal */
	observe?(
		observation: Omit<
			import("@leitwerk-dev/domain").StartupObservation,
			"workerLeaseId" | "turnRecordId"
		>,
	): void;
	/** @internal */
	shouldStop?(): boolean;
	/** @internal */
	report(phase: WorkerStartPhase): void;
}

/** @internal */
export interface WorkerRunner<TStartInput extends StartWorkerInput = StartWorkerInput> {
	/** @internal */
	start(input: TStartInput, observer?: WorkerStartObserver): Promise<WorkerUnit>;
	/** Stops the unit but keeps the process volume for resume. */
	/** @internal */
	stop(ref: WorkerUnitRef, opts: StopWorkerOptions): Promise<void>;
	/** Adoption scan: lists labelled worker units. */
	/** @internal */
	list(): Promise<WorkerUnitDescriptor[]>;
	/** Reconnects to a live unit discovered by {@link WorkerRunner.list}. */
	/** @internal */
	adopt(descriptor: WorkerUnitDescriptor, observer?: WorkerStartObserver): Promise<WorkerUnit>;
}
