/**
 * Minimal Docker Engine API port used by the Docker {@link WorkerRunner}.
 *
 * This is deliberately a narrow, leitwerk-shaped interface rather than the
 * full dockerode surface so the runner can be unit-tested against a fake engine
 * client with no daemon. A thin real adapter maps dockerode (or any
 * Docker-compatible Engine API: Podman, OrbStack, nerdctl) onto these methods.
 */

export interface DockerMountSpec {
	/** Host path (bind) or named volume identifier. */
	source: string;
	/** Mount path inside the container. */
	target: string;
	/** Mount read-only inside the container. */
	readOnly?: boolean;
	/** Mount only this relative directory of a named volume, without copying image files into it. */
	volumeSubpath?: string;
}

export interface DockerContainerSpec {
	name: string;
	image: string;
	/** `KEY=value` env entries. */
	env: string[];
	/** Container command override. */
	command?: string[];
	labels: Record<string, string>;
	mounts: DockerMountSpec[];
	/** Docker network the container attaches to (user-defined bridge). */
	networkMode: string;
	/** Maps to HostConfig.Privileged; set for privileged DinD isolation. */
	privileged: boolean;
	/**
	 * HostConfig.Runtime override. Set to the host's sysbox runtime for sysbox
	 * DinD so the worker gets a nested daemon without `--privileged`. Omitted for
	 * the default runtime.
	 */
	runtime?: string;
	/**
	 * Anonymous volumes Docker manages for the container (no host source). Used
	 * to back the inner `dockerd` storage (`/var/lib/docker`) under DinD so inner
	 * image/layer state never lands in the server-opaque process volume.
	 */
	anonymousVolumes?: string[];
	/** NanoCPUs (1 CPU == 1e9). Omitted when no limit is configured. */
	nanoCpus?: number;
	/** Memory limit in bytes. Omitted when no limit is configured. */
	memoryBytes?: number;
}

export interface DockerContainerExit {
	statusCode: number;
	oomKilled?: boolean;
	/** Termination signal name when the runtime reports one. */
	signal?: string;
	/** Human-readable error surfaced by the runtime, if any. */
	error?: string;
}

export interface DockerContainerInspect {
	id: string;
	running: boolean;
	labels: Record<string, string>;
}

export interface DockerContainerSummary {
	id: string;
	labels: Record<string, string>;
}

export interface DockerListContainersFilter {
	labels: Record<string, string>;
}

export interface DockerEngineClient {
	createContainer(spec: DockerContainerSpec): Promise<{ id: string }>;
	startContainer(id: string): Promise<void>;
	/** Graceful stop, escalating to SIGKILL after `timeoutSeconds`. */
	stopContainer(id: string, opts: { timeoutSeconds: number }): Promise<void>;
	removeContainer(id: string, opts: { force?: boolean }): Promise<void>;
	inspectContainer(id: string): Promise<DockerContainerInspect>;
	listContainers(filter: DockerListContainersFilter): Promise<DockerContainerSummary[]>;
	/** Resolves when the container exits. Used to drive `onExit`. */
	waitContainer(id: string): Promise<DockerContainerExit>;
	/** Idempotently ensures a named volume exists (named_volume mode). */
	ensureVolume(name: string): Promise<void>;
	/** Removes a named volume (retention cleanup only). */
	removeVolume(name: string): Promise<void>;
}
