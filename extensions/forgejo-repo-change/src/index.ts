import { forgejoIntegration } from "@leitwerk-dev/forgejo";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { woodpeckerIntegration } from "@leitwerk-dev/woodpecker";
import { createForgejoRepoChangeLauncher, defaultForgejoRepoChangeLauncher } from "./launcher.js";
import { createForgejoRepoChangeProcess, forgejoRepoChangeProcess } from "./process.js";
import { parseProfileBindings } from "./profile-bindings.js";

export const manifest = {
	id: "forgejo-repo-change",
	version: "0.1.9",
	requires: ["forgejo", "woodpecker", "coding", "git-ssh"],
} as const;

function extensionFor(
	launcher: ReturnType<typeof createForgejoRepoChangeLauncher>,
	process: typeof forgejoRepoChangeProcess,
): LeitwerkExtensionModule {
	return {
		manifest,
		setupCatalog(api) {
			api.registerProcess(process);
		},
		setupServer(api, config) {
			const forgejo = api.require(forgejoIntegration);
			const gitSsh = api.require(gitSshIntegration);
			const woodpecker = api.require(woodpeckerIntegration);
			if (Array.isArray(forgejo) || Array.isArray(gitSsh) || Array.isArray(woodpecker))
				throw new Error("Repository delivery integrations must be singular");
			launcher.configure({
				forgejo,
				gitSsh,
				woodpecker,
				profileBindings: parseProfileBindings(config),
			});
			api.onStop(() => launcher.configure(null));
		},
	};
}

/** Load exactly one variant per catalog. Only trusted composition code selects Docker. */
export function createForgejoRepoChange(options: { docker: boolean }) {
	if (typeof options.docker !== "boolean") throw new Error("docker must be a boolean");
	const launcher = createForgejoRepoChangeLauncher();
	const process = createForgejoRepoChangeProcess(launcher, options.docker);
	return { extension: extensionFor(launcher, process), process };
}

export * from "./launcher.js";
export * from "./params.js";
export * from "./process.js";
export * from "./profile-bindings.js";
export default extensionFor(defaultForgejoRepoChangeLauncher, forgejoRepoChangeProcess);
