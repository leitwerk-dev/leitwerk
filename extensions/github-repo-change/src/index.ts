import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import { githubIntegration } from "@leitwerk-dev/github";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { createGitHubRepoChangeLauncher } from "./launcher.js";
import { createGitHubRepoChangeProcess } from "./process.js";
import { parseProfileBindings } from "./profile-bindings.js";

/** @public */
export const manifest = {
	/** @public */
	id: "github-repo-change",
	/** @public */
	version: "0.1.9",
	/** @public */
	requires: ["github", "coding", "git-ssh"],
} as const;

/** Load exactly one variant per catalog. Only trusted composition code selects Docker. */
/** @public */
/** @public */
export function createGitHubRepoChange(options: {
	/** @public */
	docker: boolean;
}) {
	if (typeof options.docker !== "boolean") throw new Error("docker must be a boolean");
	const launcher = createGitHubRepoChangeLauncher();
	const process = createGitHubRepoChangeProcess(launcher, options.docker);
	const extension: LeitwerkExtensionModule = {
		manifest,
		setupCatalog(api) {
			api.registerProcess(process);
		},
		setupServer(api, config) {
			const github = api.require(githubIntegration);
			const gitSsh = api.require(gitSshIntegration);
			if (Array.isArray(github) || Array.isArray(gitSsh))
				throw new Error("Repository delivery integrations must be singular");
			launcher.configure({
				github,
				gitSsh,
				profileBindings: parseProfileBindings(config),
			});
			api.onStop(() => launcher.configure(null));
		},
	};
	/** @public */
	/** @public */
	return {
		/** @public */
		extension,
		/** @public */
		process,
		/** @public */
		launcher,
	};
}

export * from "./launcher.js";
export * from "./params.js";
export * from "./process.js";
export * from "./profile-bindings.js";
/** @public */
export const {
	extension: defaultExtension,
	process: githubRepoChangeProcess,
	launcher: defaultGitHubRepoChangeLauncher,
} = createGitHubRepoChange({ docker: true });
/** @public */
export const {
	configure: configureGitHubRepoChangeLauncher,
	preparationChecks: githubRepositoryPreparationChecks,
	resolveGitIdentity: resolveGitHubGitIdentity,
	launcher: githubRepoChangeUiLauncher,
} = defaultGitHubRepoChangeLauncher;
export default defaultExtension;
