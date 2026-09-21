/** Docker Engine operations used by workers and process exporters. */

/** @internal */
export interface DockerMountSpec {
	/** Host path (bind) or named volume identifier. @internal */
	source: string;
	/** Mount path inside the container. @internal */
	target: string;
	/** Mount read-only inside the container. @internal */
	readOnly?: boolean;
	/** Mount only this relative directory of a named volume, without copying image files into it. @internal */
	volumeSubpath?: string;
}

/** @internal */
export interface DockerContainerSpec {
	/** @internal */
	name: string;
	/** @internal */
	image: string;
	/** `KEY=value` env entries. @internal */
	env: string[];
	/** Container command override. @internal */
	command?: string[];
	/** @internal */
	labels: Record<string, string>;
	/** @internal */
	mounts: DockerMountSpec[];
	/** Docker network the container attaches to (user-defined bridge). @internal */
	networkMode: string;
	/** Maps to HostConfig.Privileged for private-daemon isolation. @internal */
	privileged: boolean;
	/** HostConfig.Runtime override. Set to `sysbox-runc` for private Docker. @internal */
	runtime?: string;
	/** NanoCPUs (1 CPU == 1e9). Omitted when no limit is configured. @internal */
	nanoCpus?: number;
	/** Memory limit in bytes. Omitted when no limit is configured. @internal */
	memoryBytes?: number;
}

/** @internal */
export interface DockerContainerExit {
	/** @internal */
	statusCode: number;
	/** @internal */
	oomKilled?: boolean;
	/** Termination signal name when the runtime reports one. @internal */
	signal?: string;
	/** Human-readable error surfaced by the runtime, if any. @internal */
	error?: string;
}

/** @internal */
export interface DockerContainerInspect {
	/** @internal */
	id: string;
	/** @internal */
	running: boolean;
	/** @internal */
	labels: Record<string, string>;
}

/** @internal */
export interface DockerContainerSummary {
	/** @internal */
	id: string;
	/** @internal */
	labels: Record<string, string>;
}

/** @internal */
export interface DockerListContainersFilter {
	/** @internal */
	labels: Record<string, string>;
}

/** @internal */
export interface DockerEngineClient {
	/** @internal */
	createContainer(spec: DockerContainerSpec): Promise<{
		/** @internal */
		id: string;
	}>;
	/** @internal */
	startContainer(id: string): Promise<void>;
	/** Graceful stop, escalating to SIGKILL after `timeoutSeconds`. @internal */
	stopContainer(
		id: string,
		opts: {
			/** @internal */
			timeoutSeconds: number;
		},
	): Promise<void>;
	/** @internal */
	removeContainer(
		id: string,
		opts: {
			/** @internal */
			force?: boolean;
		},
	): Promise<void>;
	/** @internal */
	inspectContainer(id: string): Promise<DockerContainerInspect>;
	/** @internal */
	listContainers(filter: DockerListContainersFilter): Promise<DockerContainerSummary[]>;
	/** Resolves when the container exits. Used to drive `onExit`. @internal */
	waitContainer(id: string): Promise<DockerContainerExit>;
	/** Idempotently ensures a named volume exists (named_volume mode). @internal */
	ensureVolume(name: string): Promise<void>;
	/** Removes a named volume (retention cleanup only). @internal */
	removeVolume(name: string): Promise<void>;
}
