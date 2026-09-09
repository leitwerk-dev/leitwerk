import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectRepoLocatorKind, trimToNull, type WorkerErrorClass } from "@leitwerk-dev/domain";
import {
	type FlowAutomaticRunContext,
	repositoryGitArgs,
	repositoryGitSubprocessEnv,
	type StructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";

export type DeterministicFinalizationMergeMode = "noop" | "fast_forward" | "merge_commit";

export interface GitIdentity {
	name: string;
	email: string;
}

interface DeterministicFinalizationInput {
	repoPath: string;
	workspaceClonePath: string;
	baseBranch: string;
	workBranch: string;
	expectedPostConflictHeadSha?: string | null;
	usedConflictResolution?: boolean;
	commitMessage: string;
	gitIdentity?: GitIdentity;
}

export type DeterministicFinalizationResult =
	| {
			outcome: "merge_conflict";
			params: {
				headSha: string;
				conflictedFiles: string[];
				fetchedBaseSha: string | null;
			};
	  }
	| {
			outcome: "finalized";
			params: {
				headSha: string;
				mergeMode: DeterministicFinalizationMergeMode;
				pushTarget: string;
				usedConflictResolution: boolean;
			};
			markdown: string;
	  };

export class DeterministicGitError extends Error {
	readonly errorClass: WorkerErrorClass = "git_error";

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

interface LocalSourceRepo {
	path: string;
	kind: "bare" | "non_bare";
}

function normalizeLines(value: string | null | undefined): string[] {
	if (!value) {
		return [];
	}
	return value
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

function abbreviateSha(sha: string): string {
	return sha.slice(0, 12);
}

function describeMergeMode(mode: DeterministicFinalizationMergeMode): string {
	switch (mode) {
		case "noop":
			return "Already up to date";
		case "fast_forward":
			return "Fast-forwarded from origin";
		case "merge_commit":
			return "Created a merge commit";
	}
}

function gitConfigIdentityEnv(): NodeJS.ProcessEnv {
	const env = repositoryGitSubprocessEnv("repo", { GIT_TERMINAL_PROMPT: "0" });
	// Identity is operator-owned repository/global Git configuration, never an
	// ambient worker identity or a Leitwerk override.
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
		return {
			ok: true,
			stdout,
			stderr: "",
		};
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

function gitFailureDetail(result: GitExecResult): string {
	return trimToNull(result.stderr) ?? trimToNull(result.stdout) ?? "unknown git error";
}

function checkedGit(
	repoPath: string,
	args: readonly string[],
	failureMessage: string,
	identity?: GitIdentity,
): string {
	const result = runGit(repoPath, args, identity);
	if (!result.ok) {
		throw new DeterministicGitError(`${failureMessage}: ${gitFailureDetail(result)}`);
	}
	return result.stdout;
}

function git(repoPath: string, ...args: string[]): string {
	return checkedGit(repoPath, args, `git ${args.join(" ")} failed in '${repoPath}'`).trim();
}

function gitOrNull(repoPath: string, ...args: string[]): string | null {
	const result = runGit(repoPath, args);
	if (!result.ok) {
		return null;
	}
	return trimToNull(result.stdout);
}

function repoExists(repoPath: string): boolean {
	return existsSync(repoPath) && existsSync(path.join(repoPath, ".git"));
}

function gitRepositoryExists(repoPath: string): boolean {
	return existsSync(repoPath) && runGit(repoPath, ["rev-parse", "--git-dir"]).ok;
}

function currentBranch(repoPath: string): string {
	return git(repoPath, "branch", "--show-current");
}

function currentHeadSha(repoPath: string): string {
	return git(repoPath, "rev-parse", "HEAD");
}

function originBaseRef(baseBranch: string): string {
	return `origin/${baseBranch}`;
}

function remoteOriginUrl(repoPath: string): string {
	const remoteUrl = gitOrNull(repoPath, "remote", "get-url", "origin");
	if (!remoteUrl) {
		throw new DeterministicGitError(`Repository '${repoPath}' does not have an 'origin' remote`);
	}
	return remoteUrl;
}

function expandHomePath(value: string): string {
	if (value === "~") {
		return homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(homedir(), value.slice(2));
	}
	return value;
}

function resolveLocalRepoPath(repoPath: string, repoLocator: string): string | null {
	if (detectRepoLocatorKind(repoLocator) !== "local_path") {
		return null;
	}
	if (repoLocator.startsWith("file://")) {
		try {
			return fileURLToPath(repoLocator);
		} catch {
			return null;
		}
	}
	return path.resolve(repoPath, expandHomePath(repoLocator));
}

function isBareRepository(repoPath: string): boolean {
	return git(repoPath, "rev-parse", "--is-bare-repository") === "true";
}

function resolveLocalSourceRepo(repoPath: string): LocalSourceRepo | null {
	const remoteUrl = remoteOriginUrl(repoPath);
	const localRepoPath = resolveLocalRepoPath(repoPath, remoteUrl);
	if (!localRepoPath || !gitRepositoryExists(localRepoPath)) {
		return null;
	}
	return {
		path: localRepoPath,
		kind: isBareRepository(localRepoPath) ? "bare" : "non_bare",
	};
}

function workingTreeStatus(repoPath: string): { dirtyFiles: string[] } {
	const rawStatus = gitOrNull(repoPath, "status", "--porcelain");
	const dirtyFiles = (rawStatus ?? "")
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+$/, ""))
		.filter((line) => line !== "")
		.map((line) => line.slice(2).trim())
		.filter((line) => line !== "");
	return { dirtyFiles };
}

function conflictedFiles(repoPath: string): string[] {
	return normalizeLines(gitOrNull(repoPath, "diff", "--name-only", "--diff-filter=U"));
}

function mergeHeadPath(repoPath: string): string {
	const gitDir = git(repoPath, "rev-parse", "--git-dir");
	return path.resolve(repoPath, gitDir, "MERGE_HEAD");
}

function mergeInProgress(repoPath: string): boolean {
	return existsSync(mergeHeadPath(repoPath));
}

function assertExpectedCheckout(repoPath: string, workBranch: string): void {
	const branch = currentBranch(repoPath);
	if (branch !== workBranch) {
		throw new DeterministicGitError(
			`Expected '${repoPath}' to be checked out on '${workBranch}', but found '${branch || "detached HEAD"}'`,
		);
	}
}

function assertFinalizationCheckout(input: {
	repoPath: string;
	workBranch: string;
	commitMessage: string;
	missingCommitMessage: string;
}): void {
	if (!repoExists(input.repoPath)) {
		throw new DeterministicGitError(
			`Repository workspace '${input.repoPath}' does not exist or is not a git repository`,
		);
	}
	assertExpectedCheckout(input.repoPath, input.workBranch);
	if (!trimToNull(input.commitMessage)) {
		throw new DeterministicGitError(input.missingCommitMessage);
	}
}

function assertGitIdentity(repoPath: string, identity?: GitIdentity): void {
	const author = runGit(repoPath, ["var", "GIT_AUTHOR_IDENT"], identity);
	const committer = runGit(repoPath, ["var", "GIT_COMMITTER_IDENT"], identity);
	if (!author.ok || !committer.ok) {
		throw new DeterministicGitError(
			"Git author/committer identity is not configured. Configure user.name and user.email in this repository or the operator's global Git config, then retry finalization.",
		);
	}
}

function commitDirtyWorktree(
	repoPath: string,
	commitMessage: string,
	identity?: GitIdentity,
): string {
	assertGitIdentity(repoPath, identity);
	checkedGit(repoPath, ["add", "--all"], "Failed to stage the completed change");
	checkedGit(
		repoPath,
		["-c", "core.hooksPath=/dev/null", "commit", "--no-gpg-sign", "-m", commitMessage],
		"Failed to commit the completed change",
		identity,
	);
	const remaining = workingTreeStatus(repoPath);
	if (remaining.dirtyFiles.length > 0) {
		throw new DeterministicGitError(
			`Deterministic commit left uncommitted changes: ${remaining.dirtyFiles.join(", ")}`,
		);
	}
	return currentHeadSha(repoPath);
}

function commitIfDirty(input: {
	repoPath: string;
	commitMessage: string;
	gitIdentity?: GitIdentity;
}): string {
	const status = workingTreeStatus(input.repoPath);
	return status.dirtyFiles.length > 0
		? commitDirtyWorktree(input.repoPath, input.commitMessage, input.gitIdentity)
		: currentHeadSha(input.repoPath);
}

function assertPostConflictCheckpoint(
	input: DeterministicFinalizationInput,
	repoPath: string,
): void {
	if (!trimToNull(input.expectedPostConflictHeadSha)) {
		return;
	}
	if (mergeInProgress(repoPath) || conflictedFiles(repoPath).length > 0) {
		throw new DeterministicGitError(
			"Conflict-resolution helper reported a clean merge, but the repository is still in a merge-conflict state",
		);
	}
	const status = workingTreeStatus(repoPath);
	if (status.dirtyFiles.length > 0) {
		throw new DeterministicGitError(
			`Conflict-resolution helper reported a clean merge, but the repository still has uncommitted changes: ${status.dirtyFiles.join(", ")}`,
		);
	}
}

function fetchOriginBase(repoPath: string, baseBranch: string): string {
	const ref = originBaseRef(baseBranch);
	checkedGit(repoPath, ["fetch", "origin", baseBranch], `Failed to fetch '${ref}'`);
	const baseSha = gitOrNull(repoPath, "rev-parse", ref);
	if (!baseSha) {
		throw new DeterministicGitError(`Fetched '${ref}' but could not resolve its commit sha`);
	}
	return baseSha;
}

function isAncestor(repoPath: string, olderRef: string, newerRef: string): boolean {
	return runGit(repoPath, ["merge-base", "--is-ancestor", olderRef, newerRef]).ok;
}

function deterministicMerge(input: {
	repoPath: string;
	baseBranch: string;
	headBefore: string;
	baseSha: string;
	gitIdentity?: GitIdentity;
}):
	| { ok: true; mergeMode: DeterministicFinalizationMergeMode; headSha: string }
	| { ok: false; conflict: true; headSha: string; conflictedFiles: string[] } {
	const { repoPath, baseBranch, headBefore, baseSha } = input;
	const ref = originBaseRef(baseBranch);
	const headIsAncestorOfBase = isAncestor(repoPath, headBefore, ref);
	const baseIsAncestorOfHead = isAncestor(repoPath, ref, headBefore);

	if (baseIsAncestorOfHead) {
		return { ok: true, mergeMode: "noop", headSha: headBefore };
	}

	if (headIsAncestorOfBase) {
		checkedGit(repoPath, ["merge", "--ff-only", ref], `Fast-forward merge from '${ref}' failed`);
		return {
			ok: true,
			mergeMode: "fast_forward",
			headSha: currentHeadSha(repoPath),
		};
	}

	assertGitIdentity(repoPath, input.gitIdentity);
	const mergeResult = runGit(
		repoPath,
		["-c", "core.hooksPath=/dev/null", "merge", "--no-edit", "--no-gpg-sign", ref],
		input.gitIdentity,
	);
	if (!mergeResult.ok) {
		const conflicts = conflictedFiles(repoPath);
		if (mergeInProgress(repoPath) || conflicts.length > 0) {
			return {
				ok: false,
				conflict: true,
				headSha: currentHeadSha(repoPath),
				conflictedFiles: conflicts,
			};
		}
		throw new DeterministicGitError(
			`Deterministic merge from '${ref}' failed: ${gitFailureDetail(mergeResult)}`,
		);
	}

	const headAfter = currentHeadSha(repoPath);
	return {
		ok: true,
		mergeMode: headAfter === baseSha ? "fast_forward" : "merge_commit",
		headSha: headAfter,
	};
}

function branchRef(branch: string): string {
	return `refs/heads/${branch}`;
}

function pushAndVerify(repoPath: string, branch: string, expectedHeadSha: string): string {
	const pushTarget = `origin/${branch}`;
	checkedGit(
		repoPath,
		["push", "origin", `HEAD:${branchRef(branch)}`],
		`Failed to push HEAD to '${pushTarget}'`,
	);
	const remoteHead = gitOrNull(repoPath, "ls-remote", "--heads", "origin", branchRef(branch))
		?.split(/\s+/)[0]
		?.trim();
	if (remoteHead !== expectedHeadSha) {
		throw new DeterministicGitError(
			`Published '${pushTarget}' resolved to '${remoteHead ?? "missing"}', expected '${expectedHeadSha}'`,
		);
	}
	return pushTarget;
}

function assertLocalSourceBaseRef(input: {
	localSourceRepoPath: string;
	baseBranch: string;
	expectedHeadSha: string;
	operation: string;
}): void {
	const ref = branchRef(input.baseBranch);
	const actualHeadSha = gitOrNull(input.localSourceRepoPath, "rev-parse", ref);
	if (!actualHeadSha) {
		throw new DeterministicGitError(
			`Local source repo '${input.localSourceRepoPath}' does not have '${ref}' ${input.operation}`,
		);
	}
	if (actualHeadSha !== input.expectedHeadSha) {
		throw new DeterministicGitError(
			`Local source repo '${input.localSourceRepoPath}' has '${ref}' at '${actualHeadSha}', but expected '${input.expectedHeadSha}' ${input.operation}`,
		);
	}
}

function assertLocalBareSourceRepoReady(
	localSourceRepoPath: string,
	baseBranch: string,
	expectedBaseSha: string,
): void {
	assertLocalSourceBaseRef({
		localSourceRepoPath,
		baseBranch,
		expectedHeadSha: expectedBaseSha,
		operation: "before finalization could publish the workspace branch. Retry finalization.",
	});
}

function pushLocalSourceBaseBranchToOriginIfPresent(input: {
	localSourceRepoPath: string;
	baseBranch: string;
	expectedHeadSha: string;
}): string | null {
	if (!runGit(input.localSourceRepoPath, ["remote", "get-url", "origin"]).ok) {
		return null;
	}
	assertLocalSourceBaseRef({
		localSourceRepoPath: input.localSourceRepoPath,
		baseBranch: input.baseBranch,
		expectedHeadSha: input.expectedHeadSha,
		operation: "before pushing it to its origin remote",
	});
	const ref = branchRef(input.baseBranch);
	const pushTarget = originBaseRef(input.baseBranch);
	checkedGit(
		input.localSourceRepoPath,
		["push", "origin", `${ref}:${ref}`],
		`Failed to push local source repo '${input.localSourceRepoPath}' base branch '${input.baseBranch}' to '${pushTarget}'`,
	);
	return pushTarget;
}

function assertLocalBaseRepoReady(
	localBaseRepoPath: string,
	baseBranch: string,
	expectedBaseSha: string,
): void {
	const branch = currentBranch(localBaseRepoPath);
	if (branch !== baseBranch) {
		throw new DeterministicGitError(
			`Expected local source repo '${localBaseRepoPath}' to be checked out on '${baseBranch}', but found '${branch || "detached HEAD"}'`,
		);
	}
	if (mergeInProgress(localBaseRepoPath) || conflictedFiles(localBaseRepoPath).length > 0) {
		throw new DeterministicGitError(
			`Local source repo '${localBaseRepoPath}' must not already be in a merge-conflict state before finalization updates '${baseBranch}'`,
		);
	}
	const status = workingTreeStatus(localBaseRepoPath);
	if (status.dirtyFiles.length > 0) {
		throw new DeterministicGitError(
			`Local source repo '${localBaseRepoPath}' must be clean before finalization updates '${baseBranch}': ${status.dirtyFiles.join(", ")}`,
		);
	}
	const actualBaseSha = currentHeadSha(localBaseRepoPath);
	if (actualBaseSha !== expectedBaseSha) {
		throw new DeterministicGitError(
			`Local source repo '${localBaseRepoPath}' moved on '${baseBranch}' from '${expectedBaseSha}' to '${actualBaseSha}' before finalization could continue. Retry finalization.`,
		);
	}
}

function mergeWorkBranchIntoLocalBaseRepo(input: {
	localBaseRepoPath: string;
	baseBranch: string;
	workBranch: string;
	expectedBaseSha: string;
	expectedHeadSha: string;
}): void {
	assertLocalBaseRepoReady(input.localBaseRepoPath, input.baseBranch, input.expectedBaseSha);
	checkedGit(
		input.localBaseRepoPath,
		["merge", "--ff-only", `refs/heads/${input.workBranch}`],
		`Failed to fast-forward local source repo '${input.localBaseRepoPath}' branch '${input.baseBranch}' from '${input.workBranch}'`,
	);
	const actualHeadSha = currentHeadSha(input.localBaseRepoPath);
	if (actualHeadSha !== input.expectedHeadSha) {
		throw new DeterministicGitError(
			`Local source repo '${input.localBaseRepoPath}' finished finalization at '${actualHeadSha}', but expected '${input.expectedHeadSha}' after merging '${input.workBranch}' into '${input.baseBranch}'`,
		);
	}
}

function updateLocalBaseRef(repoPath: string, baseBranch: string): void {
	const branch = currentBranch(repoPath);
	if (branch === baseBranch) {
		return;
	}
	checkedGit(
		repoPath,
		["branch", "--force", baseBranch, "HEAD"],
		`Failed to update the local '${baseBranch}' ref to the finalized HEAD`,
	);
}

function buildFinalizationMarkdown(input: {
	workspaceClonePath: string;
	baseBranch: string;
	workBranch: string;
	headSha: string;
	mergeMode: DeterministicFinalizationMergeMode;
	pushTarget: string;
	localSourceRepoPath: string | null;
	localSourceRepoKind: LocalSourceRepo["kind"] | null;
	workspacePushTarget: string | null;
	sourceOriginPushTarget: string | null;
	usedConflictResolution: boolean;
}): string {
	const lines = [
		"## Finalized change",
		"",
		`- Repository workspace: ${input.workspaceClonePath}`,
		`- Work branch: ${input.workBranch}`,
		`- Base branch: ${input.baseBranch}`,
		`- Merge result: ${describeMergeMode(input.mergeMode)}`,
	];
	if (input.localSourceRepoPath) {
		lines.push(
			`- Local source repo: ${input.localSourceRepoPath} (${input.localSourceRepoKind === "bare" ? "bare" : "non-bare"})`,
		);
		if (input.workspacePushTarget) {
			lines.push(`- Workspace publish: HEAD -> ${input.workspacePushTarget}`);
		}
		if (input.localSourceRepoKind === "non_bare") {
			lines.push(`- Base repo merge: ${input.workBranch} -> ${input.baseBranch}`);
		}
		if (input.sourceOriginPushTarget) {
			lines.push(
				`- Source origin push: ${branchRef(input.baseBranch)} -> ${input.sourceOriginPushTarget}`,
			);
		} else {
			lines.push("- Source origin push: skipped (local source repo has no origin remote)");
		}
	} else {
		lines.push(`- Pushed: HEAD -> ${input.pushTarget}`);
	}
	lines.push(
		`- Final HEAD: \`${abbreviateSha(input.headSha)}\``,
		`- Conflict resolution used: ${input.usedConflictResolution ? "yes" : "no"}`,
	);
	return lines.join("\n");
}

export interface RepositoryChangeFinalizationContextState extends StructuralProcessState {
	finalization: {
		expectedPostConflictHeadSha: string | null;
		usedConflictResolution: boolean;
		generatedCommitMessage: string | null;
	};
}

/** Commit the current workspace change and non-force push only the feature branch. */
export function commitAndPushWorkBranch(input: {
	repoPath: string;
	workBranch: string;
	commitMessage: string;
	gitIdentity: GitIdentity;
}) {
	const repoPath = path.resolve(input.repoPath);
	assertFinalizationCheckout({
		repoPath,
		workBranch: input.workBranch,
		commitMessage: input.commitMessage,
		missingCommitMessage: "A generated commit message is required before publication",
	});
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
	const pushTarget = pushAndVerify(repoPath, input.workBranch, headSha);
	return { headSha, pushTarget };
}

export function runDeterministicFinalization<
	TParams,
	TState extends RepositoryChangeFinalizationContextState,
>(
	ctx: FlowAutomaticRunContext<TParams, TState>,
	gitIdentity?: GitIdentity,
): DeterministicFinalizationResult {
	const progressSteps = [
		["validate_checkout", "Validate the repository checkout"],
		["fetch_base", "Fetch and verify the latest base branch"],
		["commit_merge", "Commit changes and integrate the base branch"],
		["publish", "Push the finalized branch"],
	] as const;
	const reportProgress = (
		activeIndex: number | null,
		completedCount: number,
		failure?: { index: number; detail: string },
	) =>
		ctx.reportProgress?.({
			title: "Finalization progress",
			steps: progressSteps.map(([id, label], index) => ({
				id,
				label,
				status:
					index === failure?.index
						? "failed"
						: index < completedCount
							? "completed"
							: index === activeIndex
								? "in_progress"
								: "incomplete",
				...(index === failure?.index ? { detail: failure.detail } : {}),
			})),
		});
	reportProgress(0, 0);
	const repo = ctx.repo.get("repo");
	const input: DeterministicFinalizationInput = {
		repoPath: repo.fsPath,
		workspaceClonePath: repo.workspaceClonePath,
		baseBranch: repo.baseBranch,
		workBranch: repo.workBranch,
		expectedPostConflictHeadSha: ctx.state.finalization.expectedPostConflictHeadSha,
		usedConflictResolution: ctx.state.finalization.usedConflictResolution,
		commitMessage: ctx.state.finalization.generatedCommitMessage ?? "",
		gitIdentity,
	};
	const repoPath = path.resolve(input.repoPath);
	assertFinalizationCheckout({
		repoPath,
		workBranch: input.workBranch,
		commitMessage: input.commitMessage,
		missingCommitMessage:
			"No generated commit message is available; retry commit-message generation before finalization",
	});
	assertPostConflictCheckpoint(input, repoPath);
	reportProgress(1, 1);

	let headSha = currentHeadSha(repoPath);
	const conflicts = conflictedFiles(repoPath);
	if (mergeInProgress(repoPath) || conflicts.length > 0) {
		reportProgress(null, 1, {
			index: 2,
			detail: "The checkout already contains merge conflicts",
		});
		return {
			outcome: "merge_conflict",
			params: {
				headSha,
				conflictedFiles: conflicts,
				fetchedBaseSha: null,
			},
		};
	}

	const baseSha = fetchOriginBase(repoPath, input.baseBranch);
	const localSourceRepo = resolveLocalSourceRepo(repoPath);
	if (localSourceRepo?.kind === "non_bare") {
		assertLocalBaseRepoReady(localSourceRepo.path, input.baseBranch, baseSha);
	} else if (localSourceRepo?.kind === "bare") {
		assertLocalBareSourceRepoReady(localSourceRepo.path, input.baseBranch, baseSha);
	}
	reportProgress(2, 2);

	headSha = commitIfDirty({
		repoPath,
		commitMessage: input.commitMessage,
		gitIdentity: input.gitIdentity,
	});
	const mergeResult = deterministicMerge({
		repoPath,
		baseBranch: input.baseBranch,
		headBefore: headSha,
		baseSha,
		gitIdentity: input.gitIdentity,
	});
	if (!mergeResult.ok) {
		reportProgress(null, 2, {
			index: 2,
			detail: "Base integration produced merge conflicts",
		});
		return {
			outcome: "merge_conflict",
			params: {
				headSha: mergeResult.headSha,
				conflictedFiles: mergeResult.conflictedFiles,
				fetchedBaseSha: baseSha,
			},
		};
	}

	reportProgress(3, 3);
	let pushTarget: string;
	let workspacePushTarget: string | null = null;
	let sourceOriginPushTarget: string | null = null;
	if (localSourceRepo) {
		if (localSourceRepo.kind === "non_bare") {
			assertLocalBaseRepoReady(localSourceRepo.path, input.baseBranch, baseSha);
			workspacePushTarget = pushAndVerify(repoPath, input.workBranch, mergeResult.headSha);
			mergeWorkBranchIntoLocalBaseRepo({
				localBaseRepoPath: localSourceRepo.path,
				baseBranch: input.baseBranch,
				workBranch: input.workBranch,
				expectedBaseSha: baseSha,
				expectedHeadSha: mergeResult.headSha,
			});
		} else {
			assertLocalBareSourceRepoReady(localSourceRepo.path, input.baseBranch, baseSha);
			workspacePushTarget = pushAndVerify(repoPath, input.baseBranch, mergeResult.headSha);
		}
		sourceOriginPushTarget = pushLocalSourceBaseBranchToOriginIfPresent({
			localSourceRepoPath: localSourceRepo.path,
			baseBranch: input.baseBranch,
			expectedHeadSha: mergeResult.headSha,
		});
		pushTarget = sourceOriginPushTarget ?? originBaseRef(input.baseBranch);
	} else {
		pushTarget = pushAndVerify(repoPath, input.baseBranch, mergeResult.headSha);
	}
	updateLocalBaseRef(repoPath, input.baseBranch);
	const finalHeadSha = currentHeadSha(repoPath);
	reportProgress(null, 4);
	return {
		outcome: "finalized",
		params: {
			headSha: finalHeadSha,
			mergeMode: mergeResult.mergeMode,
			pushTarget,
			usedConflictResolution: input.usedConflictResolution === true,
		},
		markdown: buildFinalizationMarkdown({
			workspaceClonePath: input.workspaceClonePath,
			baseBranch: input.baseBranch,
			workBranch: input.workBranch,
			headSha: finalHeadSha,
			mergeMode: mergeResult.mergeMode,
			pushTarget,
			localSourceRepoPath: localSourceRepo?.path ?? null,
			localSourceRepoKind: localSourceRepo?.kind ?? null,
			workspacePushTarget,
			sourceOriginPushTarget,
			usedConflictResolution: input.usedConflictResolution === true,
		}),
	};
}

export function readMergeMessage(repoPath: string): string | null {
	const messagePath = path.resolve(repoPath, git(repoPath, "rev-parse", "--git-dir"), "MERGE_MSG");
	if (!existsSync(messagePath)) {
		return null;
	}
	return trimToNull(readFileSync(messagePath, "utf8"));
}
