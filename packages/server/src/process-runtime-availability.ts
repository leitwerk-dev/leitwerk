import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import { parseDurationMs } from "@leitwerk-dev/watcher-utils";
import { preflightHostDocker } from "@leitwerk-dev/worker-runners/local";
import type { LeitwerkConfig } from "./config/config-types.js";
import { resolveKubernetesDockerIsolation } from "./config/kubernetes-docker-isolation.js";

export interface ProcessRuntimeAvailabilityDeps {
	config: LeitwerkConfig;
	processes: ReadonlyMap<string, ExtensionProcessDefinition>;
	dockerInfo?: (timeoutMs: number) => Promise<void>;
}

export interface ResolvedKubernetesDockerConfig {
	runtimeClassName: string;
	nodeSelector?: Record<string, string>;
	hostUsers?: boolean;
	isolation?: "gvisor" | "virtual-machine";
	processStorageClassName: string;
	network?: import("./config/config-types.js").KubernetesDockerConfig["network"];
}

/** Resolves the complete trusted Kubernetes Docker block used by availability and launch. */
export function resolveKubernetesDockerConfig(
	config: LeitwerkConfig,
): ResolvedKubernetesDockerConfig | undefined {
	const docker = config.kubernetes?.docker;
	const { isolation, errors } = resolveKubernetesDockerIsolation(docker);
	if (
		!docker?.runtime_class_name?.trim() ||
		errors.length > 0 ||
		(isolation === undefined && typeof docker.host_users !== "boolean") ||
		!docker.process_storage_class_name?.trim()
	) {
		return undefined;
	}
	return {
		runtimeClassName: docker.runtime_class_name,
		...(docker.node_selector ? { nodeSelector: { ...docker.node_selector } } : {}),
		...(isolation ? { isolation } : { hostUsers: docker.host_users }),
		processStorageClassName: docker.process_storage_class_name,
		...(docker.network ? { network: docker.network } : {}),
	};
}

/** Reject unsupported process runtime requirements before durable launch state is created. */
export async function assertProcessRuntimeAvailable(
	deps: ProcessRuntimeAvailabilityDeps,
	processId: string,
): Promise<void> {
	const process = deps.processes.get(processId);
	if (!process?.runtime?.docker) return;

	switch (deps.config.workers.runner) {
		case "kubernetes":
			if (!resolveKubernetesDockerConfig(deps.config)) {
				throw new Error(
					"This process requires Docker; configure kubernetes.docker.runtime_class_name, process_storage_class_name, and either isolation or host_users",
				);
			}
			return;
		case "docker":
			if (!deps.config.docker?.private_daemon) {
				throw new Error("This process requires Docker; configure docker.private_daemon.isolation");
			}
			return;
		case "local":
			if (deps.config.local_worker?.allow_host_docker !== true) {
				throw new Error(
					"This process requires Docker; set local_worker.allow_host_docker: true to acknowledge host Docker authority",
				);
			}
			try {
				await (deps.dockerInfo ?? preflightHostDocker)(
					parseDurationMs(deps.config.workers.startup_timeout, 30_000, { allowHours: true }),
				);
			} catch (error) {
				throw new Error("This process requires Docker, but `docker info` failed", { cause: error });
			}
	}
}
