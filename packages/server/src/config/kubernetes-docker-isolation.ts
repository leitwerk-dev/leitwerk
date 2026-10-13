import type { KubernetesDockerConfig } from "./config-types.js";

/** Normalize trusted sandbox selection before passing it to a worker runner. @internal */
export function resolveKubernetesDockerIsolation(docker: KubernetesDockerConfig | undefined): {
	isolation: KubernetesDockerConfig["isolation"];
	errors: string[];
} {
	const isolation = docker?.isolation ?? (docker?.gvisor ? "gvisor" : undefined);
	const errors: string[] = [];
	if (
		docker?.isolation !== undefined &&
		docker.gvisor !== undefined &&
		docker.gvisor !== (docker.isolation === "gvisor")
	) {
		errors.push("kubernetes.docker.gvisor conflicts with kubernetes.docker.isolation");
	}
	if (isolation !== undefined && docker?.host_users !== undefined) {
		errors.push("kubernetes.docker.host_users must be omitted for sandbox isolation");
	}
	return { isolation, errors };
}
