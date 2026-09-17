import type { WorkerDockerRegistryCredential } from "@leitwerk-dev/worker-protocol";
import type { LeitwerkConfig } from "./config/config-types.js";

/** Bindings are operator-owned; process parameters never select credentials. */
export function resolveDockerRegistryCredentials(
	config: LeitwerkConfig,
	processId: string,
	dockerEnabled: boolean,
): WorkerDockerRegistryCredential[] {
	if (!dockerEnabled) return [];
	const section = config.docker_registries;
	const registries = new Set<string>();
	return (section?.process_bindings[processId] ?? []).map((id) => {
		const profile = section?.profiles[id];
		if (!profile) throw new Error("Docker registry binding references an unknown profile");
		const registry = profile.registry.toLowerCase();
		if (registries.has(registry)) throw new Error("Duplicate Docker registry credentials");
		registries.add(registry);
		return { registry, username: profile.username, password: profile.password };
	});
}
