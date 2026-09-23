import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { repositoryHttpsUrl } from "@leitwerk-dev/process-sdk";

const exec = promisify(execFile);
/** Credentials stay in the child environment and never appear in URLs or error output. */
export async function preflightGitLabRepository(input: {
	url: string;
	origin: string;
	token: string;
	baseBranch: string;
	workBranch: string;
	signal?: AbortSignal;
}) {
	const url = repositoryHttpsUrl(input.url);
	if (url.origin !== input.origin)
		throw new Error("GitLab repository origin does not match its profile");
	const directory = await mkdtemp(join(tmpdir(), "leitwerk-gitlab-preflight-"));
	try {
		const askpass = join(directory, "askpass");
		await writeFile(
			askpass,
			'#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" oauth2;; *) printf "%s\\n" "$LEITWERK_GITLAB_PREFLIGHT_TOKEN";; esac\n',
			{ mode: 0o700 },
		);
		const env = {
			...process.env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_ASKPASS: askpass,
			LEITWERK_GITLAB_PREFLIGHT_TOKEN: input.token,
		};
		const git = (args: string[]) =>
			exec("git", ["-c", "credential.helper=", "-c", "http.followRedirects=false", ...args], {
				env,
				signal: input.signal,
			});
		await git(["check-ref-format", `refs/heads/${input.baseBranch}`]);
		await git(["check-ref-format", `refs/heads/${input.workBranch}`]);
		await git(["ls-remote", "--exit-code", input.url, `refs/heads/${input.baseBranch}`]);
		await git(["init", "--quiet", directory]);
		await git([
			"-C",
			directory,
			"fetch",
			"--quiet",
			"--depth=1",
			input.url,
			`refs/heads/${input.baseBranch}`,
		]);
		await git([
			"-C",
			directory,
			"push",
			"--dry-run",
			input.url,
			`FETCH_HEAD:refs/heads/${input.workBranch}`,
		]);
	} catch {
		throw new Error(
			"GitLab HTTPS read/write admission failed; check repository access and write_repository scope",
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
