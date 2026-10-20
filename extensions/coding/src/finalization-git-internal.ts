import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { trimToNull, type WorkerErrorClass } from "@leitwerk-dev/domain";
import { repositoryGitArgs, repositoryGitSubprocessEnv } from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import {
	pushWasRejected,
	type RepositoryPublicationReceipt,
	readPublicationReceipt,
	savePublicationReceipt,
} from "./repository-publication-receipt.js";

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

/** @internal */
export class RemoteBranchChangedError extends DeterministicGitError {
	constructor() {
		super("The remote source branch changed before publication; reconcile and validate again");
	}
}

interface GitExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

function gitConfigIdentityEnv(projectKey: string): NodeJS.ProcessEnv {
	const env = repositoryGitSubprocessEnv(projectKey, { GIT_TERMINAL_PROMPT: "0" });
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

function repositoryGit(projectKey: string, repoPath: string) {
	function runGit(args: readonly string[], identity?: GitIdentity): GitExecResult {
		const trustedArgs = identity ? [...gitIdentityArgs(identity), ...args] : args;
		try {
			const stdout = execFileSync(resolveGitBinary(), repositoryGitArgs(trustedArgs), {
				cwd: repoPath,
				encoding: "utf8",
				env: gitConfigIdentityEnv(projectKey),
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
		args: readonly string[],
		failureMessage: string,
		identity?: GitIdentity,
	): string {
		const result = runGit(args, identity);
		if (!result.ok) {
			const detail = trimToNull(result.stderr) ?? trimToNull(result.stdout) ?? "unknown git error";
			throw new DeterministicGitError(`${failureMessage}: ${detail}`);
		}
		return result.stdout.trim();
	}

	function git(...args: string[]): string {
		return checkedGit(args, `git ${args.join(" ")} failed in '${repoPath}'`);
	}

	function gitOrNull(...args: string[]): string | null {
		const result = runGit(args);
		return result.ok ? trimToNull(result.stdout) : null;
	}

	function workingTreeStatus(): string[] {
		return (gitOrNull("status", "--porcelain") ?? "")
			.split(/\r?\n/)
			.map((line) => line.replace(/\s+$/, ""))
			.filter(Boolean)
			.map((line) => line.slice(2).trim())
			.filter(Boolean);
	}

	function conflictedFiles(): string[] {
		return (gitOrNull("diff", "--name-only", "--diff-filter=U") ?? "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
	}

	function mergeInProgress(): boolean {
		const gitDir = git("rev-parse", "--git-dir");
		return existsSync(path.resolve(repoPath, gitDir, "MERGE_HEAD"));
	}

	function assertGitIdentity(identity: GitIdentity): void {
		if (
			!runGit(["var", "GIT_AUTHOR_IDENT"], identity).ok ||
			!runGit(["var", "GIT_COMMITTER_IDENT"], identity).ok
		) {
			throw new DeterministicGitError("Git author/committer identity is not configured");
		}
	}

	function commitIfDirty(commitMessage: string, identity: GitIdentity): string {
		if (workingTreeStatus().length === 0) return git("rev-parse", "HEAD");
		assertGitIdentity(identity);
		checkedGit(["add", "--all"], "Failed to stage the completed change");
		checkedGit(
			["-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", commitMessage],
			"Failed to commit the completed change",
			identity,
		);
		const remaining = workingTreeStatus();
		if (remaining.length > 0) {
			throw new DeterministicGitError(`Commit left uncommitted changes: ${remaining.join(", ")}`);
		}
		return git("rev-parse", "HEAD");
	}

	function pushAndVerify(
		branch: string,
		expectedHeadSha: string,
		expectedRemoteHead?: string | null,
	): string {
		const ref = `refs/heads/${branch}`;
		const pushTarget = `origin/${branch}`;
		const observed = git("ls-remote", "--heads", "origin", ref).split(/\s+/)[0] || null;
		const lease = expectedRemoteHead === undefined ? observed : expectedRemoteHead;
		const directory = git("rev-parse", "--absolute-git-dir");
		const origin = git("remote", "get-url", "origin");
		const pushOrigin = git("remote", "get-url", "--push", "--all", "origin");
		if (origin !== pushOrigin)
			throw new DeterministicGitError("Fetch and push endpoints must match for publication");
		const previous = readPublicationReceipt(directory);
		if (
			previous &&
			(previous.branch !== branch ||
				previous.origin !== origin ||
				previous.pushOrigin !== pushOrigin)
		)
			throw new DeterministicGitError("Repository publication receipt binding changed");
		const receipt: RepositoryPublicationReceipt = {
			branch,
			origin,
			pushOrigin,
			expectedHead: lease,
			candidate: expectedHeadSha,
			status: "attempting",
		};
		// Recover a successful push whose acknowledgement was lost.
		if (observed === expectedHeadSha) {
			savePublicationReceipt(directory, { ...receipt, status: "accepted" });
			return pushTarget;
		}
		if (previous?.status === "attempting")
			throw new DeterministicGitError(
				"A prior publication is unresolved; retain local work and reconcile its exact candidate first",
			);
		if (previous?.status === "accepted" && previous.candidate === expectedHeadSha)
			throw new RemoteBranchChangedError();
		if (observed !== lease) throw new RemoteBranchChangedError();
		if (lease && !runGit(["merge-base", "--is-ancestor", lease, expectedHeadSha]).ok)
			throw new DeterministicGitError(
				"Ordinary publication must preserve the captured remote head",
			);
		savePublicationReceipt(directory, receipt);
		const pushed = runGit([
			"push",
			"--porcelain",
			"--no-follow-tags",
			"--recurse-submodules=no",
			`--force-with-lease=${ref}:${lease ?? ""}`,
			"origin",
			`${expectedHeadSha}:${ref}`,
		]);
		if (!pushed.ok) {
			if (pushWasRejected(pushed.stdout))
				savePublicationReceipt(directory, { ...receipt, status: "rejected" });
			const latest = git("ls-remote", "--heads", "origin", ref).split(/\s+/)[0] || null;
			if (latest === expectedHeadSha) {
				savePublicationReceipt(directory, { ...receipt, status: "accepted" });
				return pushTarget;
			}
			if (latest !== lease) throw new RemoteBranchChangedError();
			throw new DeterministicGitError(`Failed to push HEAD to '${pushTarget}': ${pushed.stderr}`);
		}
		savePublicationReceipt(directory, { ...receipt, status: "accepted" });
		const remoteHead = gitOrNull("ls-remote", "--heads", "origin", ref)?.split(/\s+/)[0]?.trim();
		if (remoteHead !== expectedHeadSha) throw new RemoteBranchChangedError();
		return pushTarget;
	}

	return { runGit, git, conflictedFiles, mergeInProgress, commitIfDirty, pushAndVerify };
}

/** Inspect staged, unstaged, untracked, and already committed unpublished changes. @public */
export function repositoryHasChanges(
	repoPath: string,
	baseBranch: string,
	projectKey = "repo",
): boolean {
	const { git } = repositoryGit(projectKey, repoPath);
	return Boolean(
		git("status", "--porcelain") || git("diff", "--name-only", `origin/${baseBranch}...HEAD`),
	);
}

/** Commit the current workspace change and non-force push only the feature branch. */
/** @public */
export function commitAndPushWorkBranch(input: {
	/** @public */ projectKey?: string;
	/** @public */
	repoPath: string;
	/** @public */
	workBranch: string;
	/** @public */
	commitMessage: string;
	/** @public */
	gitIdentity: GitIdentity;
	/** Captured remote head; null requires branch creation. @internal */
	expectedRemoteHead?: string | null;
}) {
	const repoPath = path.resolve(input.repoPath);
	const { runGit, git, conflictedFiles, mergeInProgress, commitIfDirty, pushAndVerify } =
		repositoryGit(input.projectKey ?? "repo", repoPath);
	if (!existsSync(repoPath) || !runGit(["rev-parse", "--git-dir"]).ok) {
		throw new DeterministicGitError(
			`Repository workspace '${repoPath}' does not exist or is not a git repository`,
		);
	}
	const branch = git("branch", "--show-current");
	if (branch !== input.workBranch) {
		throw new DeterministicGitError(
			`Expected '${repoPath}' to be checked out on '${input.workBranch}', but found '${branch || "detached HEAD"}'`,
		);
	}
	if (!trimToNull(input.commitMessage)) {
		throw new DeterministicGitError("A generated commit message is required before publication");
	}
	const conflicts = conflictedFiles();
	if (mergeInProgress() || conflicts.length > 0) {
		throw new DeterministicGitError(
			`Cannot publish a work branch with unresolved conflicts: ${conflicts.join(", ") || "merge in progress"}`,
		);
	}
	const headSha = commitIfDirty(input.commitMessage, input.gitIdentity);
	return {
		/** @public */
		headSha,
		/** @internal */
		pushTarget: pushAndVerify(input.workBranch, headSha, input.expectedRemoteHead),
	};
}
