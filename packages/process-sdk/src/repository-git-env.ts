import {
	INTERNAL_REPOSITORY_GIT_SSH_ENV_PREFIX,
	type SubprocessEnvInput,
	sanitizeWorkerSubprocessEnv,
} from "./subprocess-env.js";

function wrapperKey(projectKey: string): string {
	return `${INTERNAL_REPOSITORY_GIT_SSH_ENV_PREFIX}${encodeURIComponent(projectKey).replace(/%/g, "_")}`;
}

/** Worker-internal registration; the wrapper path is never copied to ordinary subprocesses. */
export function setRepositoryGitSshWrapper(projectKey: string, wrapperPath: string): void {
	process.env[wrapperKey(projectKey)] = wrapperPath;
}

export function clearRepositoryGitSshWrappers(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith(INTERNAL_REPOSITORY_GIT_SSH_ENV_PREFIX)) delete process.env[key];
	}
}

/** Safe environment for a trusted Git invocation for one process project. */
export function repositoryGitSubprocessEnv(
	projectKey: string,
	overrides: SubprocessEnvInput = {},
): NodeJS.ProcessEnv {
	const env = sanitizeWorkerSubprocessEnv(process.env, overrides);
	const wrapper = process.env[wrapperKey(projectKey)];
	if (wrapper) env.GIT_SSH = wrapper;
	return env;
}

export function repositoryGitArgs(args: readonly string[]): string[] {
	return ["-c", "core.hooksPath=/dev/null", ...args];
}
