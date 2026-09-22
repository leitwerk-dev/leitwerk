import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { trimToNull, type WorkerErrorClass } from "@leitwerk-dev/domain";
import { repositoryGitArgs, repositoryGitSubprocessEnv } from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";

/** @public */
export interface GitIdentity {
	/** @public */
	name: string;
	/** @public */
	email: string;
}

/** @internal */
export class DeterministicGitError extends Error {
	/** @internal */
	readonly errorClass: WorkerErrorClass = "git_error";

	/** @internal */
	constructor(message: string) {
		super(message);
		this.name = "DeterministicGitError";
	}
}

interface GitExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function gitConfigIdentityEnv(): NodeJS.ProcessEnv {
	const env = repositoryGitSubprocessEnv("repo", { GIT_TERMINAL_PROMPT: "0" });
	for (const key of [
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_AUTHOR_DATE",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
		"GIT_COMMITTER_DATE",
	])
		delete env[key];
	return env;
}

function gitIdentityArgs(identity: GitIdentity): string[] {
	const name = trimToNull(identity.name);
	const email = trimToNull(identity.email);
	if (!name || !email || /[\r\n\0]/.test(name) || /[\r\n\0]/.test(email)) {
		throw new DeterministicGitError("Git identity requires a valid name and email");
	}
	return ["-c", `user.name=${name}`, "-c", `user.email=${email}`];
}

function runGit(repoPath: string, args: readonly string[], identity?: GitIdentity): GitExecResult {
	const trustedArgs = identity ? [...gitIdentityArgs(identity), ...args] : args;
	try {
		const stdout = execFileSync(resolveGitBinary(), repositoryGitArgs(trustedArgs), {
			cwd: repoPath,
			encoding: "utf8",
			env: gitConfigIdentityEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout, stderr: "" };
	} catch (error) {
		const execError = error as {
			stdout?: string | Buffer;
			stderr?: string | Buffer;
			message?: string;
		};
		return {
			ok: false,
			stdout: execError.stdout?.toString() ?? "",
			stderr: execError.stderr?.toString() ?? trimToNull(execError.message) ?? "",
		};
	}
}

function checkedGit(
	repoPath: string,
	args: readonly string[],
	failureMessage: string,
	identity?: GitIdentity,
): string {
	const result = runGit(repoPath, args, identity);
	if (!result.ok) {
		const detail = trimToNull(result.stderr) ?? trimToNull(result.stdout) ?? "unknown git error";
		throw new DeterministicGitError(`${failureMessage}: ${detail}`);
	}
	return result.stdout.trim();
}

function git(repoPath: string, ...args: string[]): string {
	return checkedGit(repoPath, args, `git ${args.join(" ")} failed in '${repoPath}'`);
}

function gitOrNull(repoPath: string, ...args: string[]): string | null {
	const result = runGit(repoPath, args);
	return result.ok ? trimToNull(result.stdout) : null;
}

function workingTreeStatus(repoPath: string): string[] {
	return (gitOrNull(repoPath, "status", "--porcelain") ?? "")
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+$/, ""))
		.filter(Boolean)
		.map((line) => line.slice(2).trim())
		.filter(Boolean);
}

function conflictedFiles(repoPath: string): string[] {
	return (gitOrNull(repoPath, "diff", "--name-only", "--diff-filter=U") ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function mergeInProgress(repoPath: string): boolean {
	const gitDir = git(repoPath, "rev-parse", "--git-dir");
	return existsSync(path.resolve(repoPath, gitDir, "MERGE_HEAD"));
}

function assertGitIdentity(repoPath: string, identity: GitIdentity): void {
	if (
		!runGit(repoPath, ["var", "GIT_AUTHOR_IDENT"], identity).ok ||
		!runGit(repoPath, ["var", "GIT_COMMITTER_IDENT"], identity).ok
	) {
		throw new DeterministicGitError("Git author/committer identity is not configured");
	}
}

function commitIfDirty(input: {
	/** @public */
	repoPath: string;
	/** @public */
	commitMessage: string;
	/** @public */
	gitIdentity: GitIdentity;
}): string {
	if (workingTreeStatus(input.repoPath).length === 0)
		return git(input.repoPath, "rev-parse", "HEAD");
	assertGitIdentity(input.repoPath, input.gitIdentity);
	checkedGit(input.repoPath, ["add", "--all"], "Failed to stage the completed change");
	checkedGit(
		input.repoPath,
		["-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", input.commitMessage],
		"Failed to commit the completed change",
		input.gitIdentity,
	);
	const remaining = workingTreeStatus(input.repoPath);
	if (remaining.length > 0) {
		throw new DeterministicGitError(`Commit left uncommitted changes: ${remaining.join(", ")}`);
	}
	return git(input.repoPath, "rev-parse", "HEAD");
}

function pushAndVerify(repoPath: string, branch: string, expectedHeadSha: string): string {
	const ref = `refs/heads/${branch}`;
	const pushTarget = `origin/${branch}`;
	checkedGit(repoPath, ["push", "origin", `HEAD:${ref}`], `Failed to push HEAD to '${pushTarget}'`);
	const remoteHead = gitOrNull(repoPath, "ls-remote", "--heads", "origin", ref)
		?.split(/\s+/)[0]
		?.trim();
	if (remoteHead !== expectedHeadSha) {
		throw new DeterministicGitError(
			`Published '${pushTarget}' resolved to '${remoteHead ?? "missing"}', expected '${expectedHeadSha}'`,
		);
	}
	return pushTarget;
}

/** Commit the current workspace change and non-force push only the feature branch. */
/** @public */
export function commitAndPushWorkBranch(input: {
	/** @public */
	repoPath: string;
	/** @public */
	workBranch: string;
	/** @public */
	commitMessage: string;
	/** @public */
	gitIdentity: GitIdentity;
}) {
	const repoPath = path.resolve(input.repoPath);
	if (!existsSync(repoPath) || !runGit(repoPath, ["rev-parse", "--git-dir"]).ok) {
		throw new DeterministicGitError(
			`Repository workspace '${repoPath}' does not exist or is not a git repository`,
		);
	}
	const branch = git(repoPath, "branch", "--show-current");
	if (branch !== input.workBranch) {
		throw new DeterministicGitError(
			`Expected '${repoPath}' to be checked out on '${input.workBranch}', but found '${branch || "detached HEAD"}'`,
		);
	}
	if (!trimToNull(input.commitMessage)) {
		throw new DeterministicGitError("A generated commit message is required before publication");
	}
	const conflicts = conflictedFiles(repoPath);
	if (mergeInProgress(repoPath) || conflicts.length > 0) {
		throw new DeterministicGitError(
			`Cannot publish a work branch with unresolved conflicts: ${conflicts.join(", ") || "merge in progress"}`,
		);
	}
	const headSha = commitIfDirty({
		repoPath,
		commitMessage: input.commitMessage,
		gitIdentity: input.gitIdentity,
	});
	return {
		/** @public */
		headSha,
		/** @internal */
		pushTarget: pushAndVerify(repoPath, input.workBranch, headSha),
	};
}
