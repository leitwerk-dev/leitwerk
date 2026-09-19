import { forgejoIntegration } from "@leitwerk-dev/forgejo";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { woodpeckerIntegration } from "@leitwerk-dev/woodpecker";
import { createForgejoRepoChangeLauncher } from "./launcher.js";
import { createForgejoRepoChangeProcess } from "./process.js";
import { parseProfileBindings } from "./profile-bindings.js";

/** @internal */
const manifest = {
	/** @internal */
	id: "forgejo-repo-change",
	/** @internal */
	version: "0.1.9",
	/** @internal */
	requires: ["forgejo", "woodpecker", "coding", "git-ssh"],
} as const;

/** Load exactly one variant per catalog. Only trusted composition code selects Docker. @public */
export function createForgejoRepoChange(options: {
	/** @public */
	docker: boolean;
}) {
	if (typeof options.docker !== "boolean") throw new Error("docker must be a boolean");
	const launcher = createForgejoRepoChangeLauncher();
	const process = createForgejoRepoChangeProcess(launcher, options.docker);
	const extension: LeitwerkExtensionModule = {
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
	return {
		/** @public */
		extension,
		/** @public */
		process,
		/** @internal */
		launcher,
	};
}

export type { ForgejoRepoChangeParams } from "./params.js";

/** @internal */
const { extension: defaultExtension } = createForgejoRepoChange({ docker: true });
export default defaultExtension;
