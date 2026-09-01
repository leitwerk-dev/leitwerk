import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DockerEngineClient, DockerMountSpec } from "./docker-engine-client.js";
import { isDockerEngineNotFoundError } from "./docker-engine-http-client.js";
import { UnitExitNotifier } from "./runner-utils.js";
import type {
	IsolatedStartWorkerInput,
	ProcessVolume,
	StopWorkerOptions,
	WorkerExitInfo,
	WorkerRunner,
	WorkerUnit,
	WorkerUnitDescriptor,
	WorkerUnitRef,
} from "./types.js";
import {
	buildWorkerUnitLabels,
	managedWorkerLabelSelector,
	parseWorkerUnitIdentity,
} from "./worker-labels.js";

export type DockerProcessVolumeMode = "bind" | "named_volume";

export interface DockerProcessVolumeOptions {
	mode: DockerProcessVolumeMode;
	/** Host root for per-process bind mounts (bind mode). */
	hostRoot: string;
	/** Mount path injected into worker containers. */
	mountPath: string;
	/** Prefix for named volumes (named_volume mode). */
	namedVolumePrefix?: string;
}

export interface DockerWorkerRunnerOptions {
	engine: DockerEngineClient;
	volume: DockerProcessVolumeOptions;
	/** Shared private network attached to every worker container. */
	defaultNetwork: string;
	/** Host runtime name registered for sysbox DinD (e.g. `sysbox-runc`). */
	sysboxRuntime?: string;
	/** Host CA bundle mounted read-only into workers and exposed via NODE_EXTRA_CA_CERTS. */
	serverCaFile?: string;
}

const DEFAULT_NAMED_VOLUME_PREFIX = "leitwerk-process-";
const NANO_CPUS_PER_CPU = 1_000_000_000;
/**
 * Mount path of the inner `dockerd` storage under DinD. Backed by an anonymous
 * Docker-managed volume so inner image/layer state never lands in the
 * server-opaque process volume mounted at the worker's `mountPath`.
 */
const DIND_DAEMON_STORAGE_PATH = "/var/lib/docker";
const WORKER_SERVER_CA_MOUNT_PATH = "/leitwerk/server-ca.pem";

/** Replaces characters Docker rejects in container names. */
function sanitizeNameSegment(value: string): string {
	const cleaned = value.replace(/[^a-zA-Z0-9_.-]/g, "-");
	return cleaned.length > 0 ? cleaned : "x";
}

function containerName(instanceId: string, workerId: string): string {
	return `leitwerk-worker-${sanitizeNameSegment(instanceId)}-${sanitizeNameSegment(workerId)}`;
}

function toEnvList(env: Record<string, string>): string[] {
	return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function parseCpuToNanoCpus(cpu: string | undefined): number | undefined {
	if (cpu === undefined) {
		return undefined;
	}
	const parsed = Number.parseFloat(cpu);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return Math.round(parsed * NANO_CPUS_PER_CPU);
}

const MEMORY_SUFFIX_MULTIPLIERS: ReadonlyArray<[string, number]> = [
	["Gi", 1024 ** 3],
	["Mi", 1024 ** 2],
	["Ki", 1024],
	["G", 1000 ** 3],
	["M", 1000 ** 2],
	["K", 1000],
	["g", 1024 ** 3],
	["m", 1024 ** 2],
	["k", 1024],
	["b", 1],
	["B", 1],
];

function parseMemoryToBytes(memory: string | undefined): number | undefined {
	if (memory === undefined) {
		return undefined;
	}
	const trimmed = memory.trim();
	for (const [suffix, multiplier] of MEMORY_SUFFIX_MULTIPLIERS) {
		if (trimmed.endsWith(suffix)) {
			const value = Number.parseFloat(trimmed.slice(0, -suffix.length));
			if (!Number.isFinite(value) || value <= 0) {
				return undefined;
			}
			return Math.round(value * multiplier);
		}
	}
	const bytes = Number.parseInt(trimmed, 10);
	return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

function mapExit(info: {
	statusCode: number;
	oomKilled?: boolean;
	signal?: string;
	error?: string;
}): WorkerExitInfo {
	return {
		exitCode: Number.isFinite(info.statusCode) ? info.statusCode : null,
		signal: info.signal ?? null,
		...(info.oomKilled !== undefined ? { oomKilled: info.oomKilled } : {}),
		...(info.error !== undefined ? { reason: info.error } : {}),
	};
}

/**
 * Docker Engine API {@link ProcessVolume} / {@link WorkerRunner}.
 *
 * Container-per-process, labelled for adoption, bind- or named-volume backed.
 * The server never reads the volume; it only injects the mount. Physical
 * container exits are observed via the engine's wait call and mapped into the
 * supervisor's existing failure paths through `onExit`.
 */
export function createDockerWorkerRunner(options: DockerWorkerRunnerOptions): {
	runner: WorkerRunner<IsolatedStartWorkerInput>;
	volume: ProcessVolume;
} {
	const { engine } = options;
	const mountPath = options.volume.mountPath;
	const namedVolumePrefix = options.volume.namedVolumePrefix ?? DEFAULT_NAMED_VOLUME_PREFIX;
	function volumeId(instanceId: string): string {
		if (options.volume.mode === "named_volume") {
			return `${namedVolumePrefix}${instanceId}`;
		}
		return path.join(options.volume.hostRoot, instanceId);
	}

	async function releaseManagedStorage(instanceId: string): Promise<void> {
		if (options.volume.mode === "named_volume") {
			await engine.removeVolume(volumeId(instanceId));
		}
		// Bind mounts are retained on the host filesystem; retention/GC of the
		// host directory is an operator concern, not a runner action.
	}

	const volume: ProcessVolume = {
		async ensure(instanceId) {
			const id = volumeId(instanceId);
			if (options.volume.mode === "named_volume") {
				await engine.ensureVolume(id);
			} else {
				mkdirSync(id, { recursive: true });
			}
			return { instanceId, id, mountPath };
		},
		release: releaseManagedStorage,
		deleteProcessResources: releaseManagedStorage,
	};

	const exitNotifier = new UnitExitNotifier();
	const watched = new Set<string>();

	function watchForExit(unitId: string): void {
		if (watched.has(unitId)) return;
		watched.add(unitId);
		engine
			.waitContainer(unitId)
			.then((exit) => exitNotifier.fireExit(unitId, mapExit(exit)))
			.catch(() =>
				exitNotifier.fireExit(unitId, { exitCode: null, signal: null, reason: "wait_failed" }),
			)
			.finally(() => watched.delete(unitId));
	}

	const runner: WorkerRunner<IsolatedStartWorkerInput> = {
		async start(input: IsolatedStartWorkerInput, observer) {
			observer?.report("preparing_runtime");
			const volume = input.volume;
			const labels = buildWorkerUnitLabels({
				instanceId: input.instanceId,
				workerId: input.workerId,
				serverEpoch: input.serverEpoch,
			});
			const mounts: DockerMountSpec[] = [{ source: volume.id, target: volume.mountPath }];
			const env = { ...input.env };
			if (options.serverCaFile) {
				mounts.push({
					source: options.serverCaFile,
					target: WORKER_SERVER_CA_MOUNT_PATH,
					readOnly: true,
				});
				env.NODE_EXTRA_CA_CERTS = WORKER_SERVER_CA_MOUNT_PATH;
			}
			const privileged = input.isolation.dind === "privileged";
			const dindMode = input.isolation.dind;
			const sysbox = dindMode === "sysbox";
			if (sysbox && !options.sysboxRuntime) {
				throw new Error(
					`Cannot start worker for ${input.instanceId}: sysbox DinD requested but no host sysbox runtime is configured`,
				);
			}
			// Under any DinD mode the inner dockerd needs its own storage. Back it with
			// an anonymous Docker-managed volume so inner image/layer state stays out
			// of the server-opaque process volume and is reclaimed when the worker
			// container is removed.
			const anonymousVolumes = dindMode === false ? undefined : [DIND_DAEMON_STORAGE_PATH];
			observer?.report("allocating_runtime");
			const { id } = await engine.createContainer({
				name: containerName(input.instanceId, input.workerId),
				image: input.image.reference,
				env: toEnvList(env),
				labels,
				mounts,
				networkMode: options.defaultNetwork,
				privileged,
				...(sysbox ? { runtime: options.sysboxRuntime } : {}),
				...(anonymousVolumes ? { anonymousVolumes } : {}),
				nanoCpus: parseCpuToNanoCpus(input.resources?.cpu),
				memoryBytes: parseMemoryToBytes(input.resources?.memory),
			});
			observer?.report("starting_runtime");
			await engine.startContainer(id);
			const ref: WorkerUnitRef = {
				instanceId: input.instanceId,
				workerId: input.workerId,
				unitId: id,
			};
			watchForExit(id);
			return exitNotifier.wrapUnit(ref, ref.unitId);
		},
		async stop(ref: WorkerUnitRef, opts: StopWorkerOptions) {
			const timeoutSeconds = Math.max(0, Math.ceil(opts.graceMs / 1000));
			try {
				await engine.stopContainer(ref.unitId, { timeoutSeconds });
			} catch (error) {
				if (!isDockerEngineNotFoundError(error)) throw error;
			}
			try {
				await engine.removeContainer(ref.unitId, { force: true });
			} catch (error) {
				if (!isDockerEngineNotFoundError(error)) throw error;
			}
			// The process volume is intentionally kept for resume; removing the ephemeral
			// container reclaims Docker-managed anonymous volumes (including DinD storage).
		},
		async list(): Promise<WorkerUnitDescriptor[]> {
			const summaries = await engine.listContainers({
				labels: managedWorkerLabelSelector(),
			});
			const descriptors: WorkerUnitDescriptor[] = [];
			for (const summary of summaries) {
				const identity = parseWorkerUnitIdentity(summary.labels);
				if (!identity) {
					continue;
				}
				descriptors.push({
					instanceId: identity.instanceId,
					workerId: identity.workerId,
					unitId: summary.id,
					observedState: "running",
				});
			}
			return descriptors;
		},
		async adopt(descriptor: WorkerUnitDescriptor): Promise<WorkerUnit> {
			const inspect = await engine.inspectContainer(descriptor.unitId);
			const identity = parseWorkerUnitIdentity(inspect.labels);
			if (
				!identity ||
				identity.instanceId !== descriptor.instanceId ||
				identity.workerId !== descriptor.workerId
			) {
				throw new Error(`Cannot adopt worker unit ${descriptor.unitId}: labels changed`);
			}
			if (!inspect.running) {
				throw new Error(`Cannot adopt worker unit ${descriptor.unitId}: not running`);
			}
			const ref: WorkerUnitRef = {
				instanceId: descriptor.instanceId,
				workerId: descriptor.workerId,
				unitId: descriptor.unitId,
			};
			watchForExit(descriptor.unitId);
			return exitNotifier.wrapUnit(ref, ref.unitId);
		},
	};

	return { runner, volume };
}
