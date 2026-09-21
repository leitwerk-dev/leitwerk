import { gitlabIntegration } from "@leitwerk-dev/gitlab";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { createGitLabRepoChangeLauncher } from "./launcher.js";
import { createGitLabRepoChangeProcess } from "./process.js";
export const manifest = {
	id: "gitlab-repo-change",
	version: "0.1.9",
	requires: ["gitlab", "coding"],
} as const;
export function createGitLabRepoChange(options: { docker: boolean }) {
	if (typeof options.docker !== "boolean") throw new Error("docker must be a boolean");
	const launcher = createGitLabRepoChangeLauncher();
	const process = createGitLabRepoChangeProcess(launcher, options.docker);
	const extension: LeitwerkExtensionModule = {
		manifest,
		setupCatalog(api) {
			api.registerProcess(process);
		},
		setupServer(api) {
			const integration = api.require(gitlabIntegration);
			if (Array.isArray(integration)) throw new Error("GitLab integration must be singular");
			launcher.configure(integration);
			api.onStop(() => launcher.configure(null));
		},
	};
	return { extension, process, launcher };
}
export const {
	extension: defaultExtension,
	process: gitlabRepoChangeProcess,
	launcher: defaultGitLabRepoChangeLauncher,
} = createGitLabRepoChange({ docker: true });
export * from "./launcher.js";
export * from "./params.js";
export * from "./process.js";
export default defaultExtension;
