import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import { type GitHubGitIdentity, githubIntegration } from "@leitwerk-dev/github";
import type {
	LaunchPreparationCheck,
	LeitwerkExtensionModule,
	ProcessLaunchConfig,
} from "@leitwerk-dev/process-sdk";
import { createGitHubRepoChangeLauncher, type LauncherDependencies } from "./launcher.js";
import type { GitHubRepoChangeParams } from "./params.js";
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
export const configureGitHubRepoChangeLauncher: (value: LauncherDependencies | null) => void =
	defaultGitHubRepoChangeLauncher.configure;
/** @public */
export const githubRepositoryPreparationChecks: (
	input: unknown,
	launch: ProcessLaunchConfig<GitHubRepoChangeParams>,
) => readonly LaunchPreparationCheck<GitHubRepoChangeParams>[] =
	defaultGitHubRepoChangeLauncher.preparationChecks;
/** @public */
export const resolveGitHubGitIdentity: (profile: string) => Promise<GitHubGitIdentity> =
	defaultGitHubRepoChangeLauncher.resolveGitIdentity;
/** @public */
export const githubRepoChangeUiLauncher = defaultGitHubRepoChangeLauncher.launcher;
export default defaultExtension;
