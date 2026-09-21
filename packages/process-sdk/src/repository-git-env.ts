import {
	INTERNAL_REPOSITORY_GIT_HTTPS_ENV_PREFIX,
	INTERNAL_REPOSITORY_GIT_SSH_ENV_PREFIX,
	type SubprocessEnvInput,
	sanitizeWorkerSubprocessEnv,
} from "./subprocess-env.js";

function wrapperKey(projectKey: string): string {
	return `${INTERNAL_REPOSITORY_GIT_SSH_ENV_PREFIX}${encodeURIComponent(projectKey).replace(/%/g, "_")}`;
}

/** Worker-internal registration; the wrapper path is never copied to ordinary subprocesses. @internal */
export function setRepositoryGitSshWrapper(projectKey: string, wrapperPath: string): void {
	process.env[wrapperKey(projectKey)] = wrapperPath;
}

/** @internal */
export function clearRepositoryGitSshWrappers(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith(INTERNAL_REPOSITORY_GIT_SSH_ENV_PREFIX)) delete process.env[key];
	}
}

/** @internal */
export function setRepositoryGitHttpsHelper(projectKey: string, helperPath: string): void {
	process.env[`${INTERNAL_REPOSITORY_GIT_HTTPS_ENV_PREFIX}${encodeURIComponent(projectKey)}`] =
		helperPath;
}

/** @internal */
export function clearRepositoryGitHttpsHelpers(): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith(INTERNAL_REPOSITORY_GIT_HTTPS_ENV_PREFIX)) delete process.env[key];
	}
}

/** Safe environment for a trusted Git invocation for one process project. @public */
export function repositoryGitSubprocessEnv(
	projectKey: string,
	overrides: SubprocessEnvInput = {},
): NodeJS.ProcessEnv {
	const env = sanitizeWorkerSubprocessEnv(process.env, overrides);
	const wrapper = process.env[wrapperKey(projectKey)];
	if (wrapper) env.GIT_SSH = wrapper;
	const helper =
		process.env[`${INTERNAL_REPOSITORY_GIT_HTTPS_ENV_PREFIX}${encodeURIComponent(projectKey)}`];
	if (helper) {
		const config = [
			["credential.helper", ""],
			["credential.helper", `!${shellQuote(process.execPath)} ${shellQuote(helper)}`],
			["credential.useHttpPath", "true"],
			["http.followRedirects", "false"],
			["protocol.allow", "never"],
			["protocol.https.allow", "always"],
		];
		env.GIT_CONFIG_COUNT = String(config.length);
		config.forEach(([key, value], index) => {
			env[`GIT_CONFIG_KEY_${index}`] = key;
			env[`GIT_CONFIG_VALUE_${index}`] = value;
		});
		env.GIT_TERMINAL_PROMPT = "0";
	}
	return env;
}

/** @public */
export function repositoryGitArgs(args: readonly string[]): string[] {
	return ["-c", "core.hooksPath=/dev/null", ...args];
}

function shellQuote(value: string): string {
	return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
