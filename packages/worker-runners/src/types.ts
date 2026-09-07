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
export interface VolumeRef {
	instanceId: string;
	/** Runtime-specific identifier (host path, named volume, PVC name). */
	id: string;
	/** Path inside the worker container where the volume is mounted. */
	mountPath: string;
	/** Runtime-specific namespace/project for the volume (Kubernetes process namespace). */
	namespace?: string;
}

export type ProcessStateExportPreflight = SessionTransferPreflight;
export type ProcessStateExportHelperReport = SessionTransferPreflightReport;

/** Server-owned, credential-scoped relay used by isolated export helpers. */
export interface ProcessStateExportHelperRelay {
	readonly exportId: string;
	readonly credential: string;
	waitForPreflight(signal?: AbortSignal): Promise<ProcessStateExportHelperReport>;
	activateStream(): Readable;
	fail(error: Error): void;
}

export interface PreparedProcessStateExport {
	manifest: LeitwerkTransferManifestV1;
	preflight: ProcessStateExportPreflight;
	stream(input: { signal?: AbortSignal }): Readable;
}

/** Purpose-specific read-only export seam. It never creates a worker lease. */
export interface ProcessStateExporter {
	prepare(input: {
		instanceId: string;
		manifest: LeitwerkTransferManifestV1;
		limits: SessionTransferLimits;
		signal?: AbortSignal;
	}): Promise<PreparedProcessStateExport>;
	/** Removes stale runner-specific export helpers after restart. */
	reconcile(): Promise<void>;
}

export interface ProcessStateExportHelperRelayProvider {
	create(input: {
		instanceId: string;
		manifest: LeitwerkTransferManifestV1;
	}): ProcessStateExportHelperRelay;
}

export interface ProcessVolume {
	/** Idempotently provisions durable storage for a process instance. */
	ensure(instanceId: string): Promise<VolumeRef>;
	/** Retention cleanup only. Stopping a worker never calls this. */
	release(instanceId: string): Promise<void>;
	/** Permanently deletes every runner-managed resource owned by a deleted process. */
	deleteProcessResources(instanceId: string): Promise<void>;
}

/**
 * Output of runtime-profile selection. MVP resolves to a single configured
 * worker image; repository branch content must never select an image.
 */
export interface ResolvedWorkerImage {
	/** Fully qualified image reference, ideally digest-pinned. */
	reference: string;
}

export interface WorkerResourceLimits {
	cpu?: string;
	memory?: string;
}

/**
 * Nested-container capability for the worker.
 *
 * - `{ dind: false }` — default unprivileged worker.
 * - `{ dind: "privileged" }` — inner `dockerd` started inside the worker.
 * - `{ dind: "sysbox" }` — nested daemon without `--privileged` (host must
 *   provide the sysbox runtime).
 */
export type WorkerIsolation = { dind: false } | { dind: "privileged" | "sysbox" };

export interface WorkerUnitRef {
	instanceId: string;
	workerId: string;
	/** Runtime-specific handle id (container id, pod name). */
	unitId: string;
	/** Runtime-specific namespace/project for the unit (Kubernetes process namespace). */
	namespace?: string;
}

export interface WorkerExitInfo {
	/** Process exit code when the runtime reports one. */
	exitCode: number | null;
	/** Termination signal when the runtime reports one. */
	signal: string | null;
	/** True when the runtime killed the unit for exceeding memory limits. */
	oomKilled?: boolean;
	/** Human-readable reason surfaced by the runtime, if any. */
	reason?: string;
}

export interface WorkerUnit extends WorkerUnitRef {
	/** Maps physical worker exit into the supervisor's existing failure paths. */
	onExit(listener: (info: WorkerExitInfo) => void): void;
}

export interface WorkerUnitDescriptor extends WorkerUnitRef {
	observedState?: "running" | "pending" | "terminal" | "unknown";
}

interface StartWorkerInputBase {
	instanceId: string;
	workerId: string;
	serverEpoch: string;
	/** Runtime-profile selection output; MVP = single image. */
	image: ResolvedWorkerImage;
	/** Server URL, ids, connect token, `PI_CODING_AGENT_DIR`, etc. */
	env: Record<string, string>;
	isolation: WorkerIsolation;
	resources?: WorkerResourceLimits;
}

/** Start input for the best-effort local runner, which uses configured host storage. */
export interface LocalStartWorkerInput extends StartWorkerInputBase {
	runnerKind: "local";
	volume?: never;
}

/** Start input for isolated runners, whose durable process volume is mandatory. */
export interface IsolatedStartWorkerInput extends StartWorkerInputBase {
	runnerKind: "isolated";
	volume: VolumeRef;
}

export type StartWorkerInput = LocalStartWorkerInput | IsolatedStartWorkerInput;

export interface StopWorkerOptions {
	/** Grace period before forceful termination. The volume is always kept. */
	graceMs: number;
}

export type WorkerStartPhase = "preparing_runtime" | "allocating_runtime" | "starting_runtime";

export interface WorkerStartObserver {
	report(phase: WorkerStartPhase): void;
}

export interface WorkerRunner<TStartInput extends StartWorkerInput = StartWorkerInput> {
	start(input: TStartInput, observer?: WorkerStartObserver): Promise<WorkerUnit>;
	/** Stops the unit but keeps the process volume for resume. */
	stop(ref: WorkerUnitRef, opts: StopWorkerOptions): Promise<void>;
	/** Adoption scan: lists labelled worker units. */
	list(): Promise<WorkerUnitDescriptor[]>;
	/** Reconnects to a live unit discovered by {@link WorkerRunner.list}. */
	adopt(descriptor: WorkerUnitDescriptor): Promise<WorkerUnit>;
}
