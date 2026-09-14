import { forgejoIntegration } from "@leitwerk-dev/forgejo";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { configureForgejoRepoChangeLauncher } from "./launcher.js";
import { forgejoRepoChangeProcess } from "./process.js";

export const manifest = {
	id: "forgejo-repo-change",
	version: "0.1.9",
	requires: ["forgejo", "woodpecker", "coding", "git-ssh"],
} as const;

const extension: LeitwerkExtensionModule = {
	manifest,
	setupCatalog(api) {
		api.registerProcess(forgejoRepoChangeProcess);
	},
	setupServer(api) {
		const integration = api.require(forgejoIntegration);
		if (Array.isArray(integration)) throw new Error("Forgejo integration must be singular");
		const gitSsh = api.require(gitSshIntegration);
		if (Array.isArray(gitSsh)) throw new Error("Git SSH integration must be singular");
		configureForgejoRepoChangeLauncher({ forgejo: integration, gitSsh });
		api.onStop(() => {
			configureForgejoRepoChangeLauncher(null);
		});
	},
};

export * from "./launcher.js";
export * from "./params.js";
export * from "./process.js";
export default extension;
