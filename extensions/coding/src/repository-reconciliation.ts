import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { repositoryGitArgs, repositoryGitSubprocessEnv } from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import type { GitIdentity } from "./finalization-git.js";
import {
	type RepositoryBinding,
	readPublicationReceipt,
	readRepositoryBinding,
	repositoryBindingMatches,
	savePublicationReceipt,
} from "./repository-publication-receipt.js";
import { repositoryRecord } from "./repository-record.js";

/** @internal */
export interface ReconciliationInput {
	projectKey: string;
	repoPath: string;
	workBranch: string;
	/** Last remote baseline, not the latest observation. */
	baselineSha: string;
	/** Trusted project identity for replaying unpublished commits. */
	gitIdentity?: GitIdentity;
}

/** @internal */
export interface ReconciliationResult {
	status: "ready" | "conflicts";
	remoteHead: string | null;
	headSha: string;
	changed: boolean;
}

interface RecordState extends RepositoryBinding {
	baseline: string;
	remoteSeen?: boolean;
	protectedIgnored?: string[];
	publicationReceiptSha?: string;
	joinParent?: string;
	joinIdentity?: GitIdentity;
	sourceIntegration?: { previous: string; replacement: string };
	operation?: {
		id: string;
		head: string;
		index: string;
		work: string;
		remote: string;
		phase: "captured" | "rebasing" | "restoring";
		resultHead?: string;
		resultIndex?: string;
		identity?: GitIdentity;
	};
}

function repository(input: Pick<ReconciliationInput, "projectKey" | "repoPath">) {
	function git(args: string[], extra: NodeJS.ProcessEnv = {}): string {
		const output = execFileSync(resolveGitBinary(), repositoryGitArgs(args), {
			cwd: input.repoPath,
			encoding: "utf8",
			env: repositoryGitSubprocessEnv(input.projectKey, {
				GIT_TERMINAL_PROMPT: "0",
				GIT_EDITOR: "true",
				GIT_SEQUENCE_EDITOR: "true",
				...extra,
			}),
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 16 * 1024 * 1024,
		});
		return output.endsWith("\0") ? output : output.replace(/\r?\n$/, "");
	}
	const directory = git(["rev-parse", "--absolute-git-dir"]);
	if (
		git(["remote", "get-url", "--push", "--all", "origin"]) !== git(["remote", "get-url", "origin"])
	)
		throw new Error(
			"Repository reconciliation binding changed: fetch and push endpoints must match",
		);
	const { read, save } = repositoryRecord<RecordState>(directory, "reconciliation");
	const binding = (branch: string) => readRepositoryBinding((...args) => git(args), branch);
	return { git, directory, read, save, binding };
}

function integrationIdentityEnv(identity: GitIdentity | undefined): NodeJS.ProcessEnv {
	if (
		!identity?.name.trim() ||
		!identity.email.trim() ||
		/[\r\n\0]/.test(identity.name + identity.email)
	)
		throw new Error(
			"A trusted Git identity is required for source integration; local work was retained",
		);
	return {
		GIT_AUTHOR_NAME: identity.name,
		GIT_AUTHOR_EMAIL: identity.email,
		GIT_COMMITTER_NAME: identity.name,
		GIT_COMMITTER_EMAIL: identity.email,
	};
}

function ignoredPaths(git: ReturnType<typeof repository>["git"]): string[] {
	return git([
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"--directory",
		"--no-empty-directory",
		"-z",
	])
		.split("\0")
		.filter(Boolean)
		.map((file) => file.replace(/\/$/, ""));
}

function assertIgnoredProtection(
	git: ReturnType<typeof repository>["git"],
	protectedPaths: string[] = [],
): void {
	if (!protectedPaths.length) return;
	const visible = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0");
	if (
		protectedPaths.some((ignored) =>
			visible.some((file) => file === ignored || file.startsWith(`${ignored}/`)),
		)
	)
		throw new Error(
			"Previously ignored local files became publishable; review ignore rules before continuing. Local files were retained",
		);
}

function ignoredPathsCollide(
	git: ReturnType<typeof repository>["git"],
	ignored: string[],
	target: string,
	replayRange: string,
): boolean {
	const paths = [
		...git(["ls-tree", "-r", "--name-only", "-z", target]).split("\0"),
		...git(["log", "--format=", "--full-history", "-m", "--name-only", "-z", replayRange]).split(
			"\0",
		),
	];
	return ignored.some((file) =>
		paths.some((p) => p === file || p.startsWith(`${file}/`) || file.startsWith(`${p}/`)),
	);
}

function ancestor(git: ReturnType<typeof repository>["git"], a: string, b: string): boolean {
	try {
		git(["merge-base", "--is-ancestor", a, b]);
		return true;
	} catch (error) {
		if ((error as { status?: number }).status === 1) return false;
		throw error;
	}
}

function withLock<T>(directory: string, run: () => T): T {
	const lock = join(directory, "leitwerk-reconciliation.lock");
	try {
		mkdirSync(lock);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		// Never steal a lock from another node or a living process.
		const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"));
		if (owner.host !== hostname())
			throw new Error("Repository reconciliation is owned by another worker");
		try {
			process.kill(owner.pid, 0);
		} catch (failure) {
			if ((failure as NodeJS.ErrnoException).code !== "ESRCH") throw failure;
			rmSync(lock, { recursive: true });
			return withLock(directory, run);
		}
		throw new Error("Repository reconciliation is already running");
	}
	try {
		writeFileSync(
			join(lock, "owner.json"),
			JSON.stringify({ host: hostname(), pid: process.pid }),
			{ mode: 0o600 },
		);
		return run();
	} finally {
		rmSync(lock, { recursive: true });
	}
}

/**
 * Reconcile only unpublished work onto the fetched source branch. Checkpoint commits
 * retain the index and working tree separately, including non-ignored untracked files.
 * They are retained under private refs and removed from HEAD before publication.
 * A conflicted rebase is deliberately left in place for the existing adjustment turn.
 * @internal
 */
export function reconcileRepository(input: ReconciliationInput): ReconciliationResult {
	const { git, directory, read, save, binding: readBinding } = repository(input);
	return withLock(directory, () => {
		git(["check-ref-format", `refs/heads/${input.workBranch}`]);
		const binding = readBinding(input.workBranch);
		let record = read();
		if (!repositoryBindingMatches(record, binding))
			throw new Error("Repository reconciliation binding changed");
		if (record?.sourceIntegration) {
			if (git(["branch", "--show-current"]) !== input.workBranch)
				throw new Error("Source integration checkout branch changed; local work was retained");
			const { previous, replacement } = record.sourceIntegration;
			const current = git(["rev-parse", "HEAD"]);
			if (current === previous)
				git(["update-ref", `refs/heads/${input.workBranch}`, replacement, previous]);
			else if (current !== replacement)
				throw new Error("Checkout changed during source integration; recovery refs were retained");
			delete record.sourceIntegration;
			save(record);
		}
		const rebaseActive = () =>
			["rebase-merge", "rebase-apply"].some((name) => existsSync(join(directory, name)));
		if (rebaseActive() && !record?.operation)
			throw new Error("An unrelated rebase is already in progress; local work was retained");
		if (
			existsSync(join(directory, "MERGE_HEAD")) ||
			existsSync(join(directory, "CHERRY_PICK_HEAD"))
		)
			throw new Error("An unrelated Git operation is in progress; local work was retained");
		if (!rebaseActive() && git(["branch", "--show-current"]) !== input.workBranch)
			throw new Error(`Expected checkout on '${input.workBranch}'; local work was retained`);

		if (!record?.operation) {
			assertIgnoredProtection(git, record?.protectedIgnored);
			const ignored = ignoredPaths(git);
			// Fetch to a private ref: remote-tracking refs are not publication leases.
			git([
				"fetch",
				"--no-tags",
				"origin",
				`+refs/heads/${input.workBranch}:refs/leitwerk/reconcile-remote`,
			]);
			const remote = git(["rev-parse", "refs/leitwerk/reconcile-remote"]);
			const head = git(["rev-parse", "HEAD"]);
			let baseline = record?.baseline ?? input.baselineSha;
			const receipt = readPublicationReceipt(directory);
			if (!repositoryBindingMatches(receipt, binding))
				throw new Error("Repository publication receipt binding changed");
			if (receipt?.status === "attempting") {
				if (remote === receipt.candidate || ancestor(git, receipt.candidate, remote)) {
					receipt.status = "accepted";
					savePublicationReceipt(directory, receipt);
				} else {
					throw new Error(
						"Prior publication outcome is uncertain; local work was retained for operator reconciliation",
					);
				}
			}
			if (receipt?.status === "accepted" && record?.publicationReceiptSha !== receipt.candidate)
				baseline = receipt.candidate;
			git(["cat-file", "-e", `${baseline}^{commit}`]);
			if (!ancestor(git, baseline, head))
				throw new Error(
					"Cannot establish unpublished work from the retained baseline; local work was retained",
				);
			record = {
				...record,
				...binding,
				baseline,
				remoteSeen: true,
				protectedIgnored: [...new Set([...(record?.protectedIgnored ?? []), ...ignored])],
				publicationReceiptSha:
					receipt?.status === "accepted" ? receipt.candidate : record?.publicationReceiptSha,
			};
			if ((remote === baseline || remote === head) && !record.joinParent) {
				record.baseline = remote;
				save(record);
				return { status: "ready", remoteHead: remote, headSha: head, changed: false };
			}
			if (git(["diff", "--name-only", "--diff-filter=U"]))
				throw new Error("Unresolved local conflicts must be repaired before reconciliation");
			// Dirty submodule work cannot be represented by the parent's tree checkpoint.
			if (git(["submodule", "foreach", "--quiet", "git status --porcelain"]))
				throw new Error("Commit or preserve dirty submodule work before reconciliation");
			if (ignoredPathsCollide(git, ignored, remote, `${record.baseline}..${head}`))
				throw new Error("Remote changes collide with ignored files; local files were retained");
			// A verified remote descendant already contains these local commits, including
			// publication that succeeded before its receipt reached the server.
			if (ancestor(git, head, remote)) record.baseline = head;
			const id = randomUUID();
			const temporaryIndex = join(directory, `leitwerk-index-${id}`);
			const identity = {
				GIT_AUTHOR_NAME: "Leitwerk checkpoint",
				GIT_AUTHOR_EMAIL: "checkpoint@leitwerk.invalid",
				GIT_COMMITTER_NAME: "Leitwerk checkpoint",
				GIT_COMMITTER_EMAIL: "checkpoint@leitwerk.invalid",
			};
			try {
				const stagedTree = git(["write-tree"]);
				const index = git(
					["commit-tree", stagedTree, "-p", head, "-m", `Leitwerk index checkpoint ${id}`],
					identity,
				);
				git(["read-tree", stagedTree], { GIT_INDEX_FILE: temporaryIndex });
				git(["add", "--all"], { GIT_INDEX_FILE: temporaryIndex });
				const workTree = git(["write-tree"], { GIT_INDEX_FILE: temporaryIndex });
				const work = git(
					["commit-tree", workTree, "-p", index, "-m", `Leitwerk worktree checkpoint ${id}`],
					identity,
				);
				// Reachability and journal precede every change to the checkout.
				git(["update-ref", `refs/leitwerk/checkpoints/${id}`, work]);
				const replayIdentity = record.joinIdentity ?? input.gitIdentity;
				if (replayIdentity || record.baseline !== head) integrationIdentityEnv(replayIdentity);
				record.operation = {
					id,
					head,
					index,
					work,
					remote,
					phase: "captured",
					identity: replayIdentity,
				};
				save(record);
			} finally {
				rmSync(temporaryIndex, { force: true });
			}
		}
		const operation = record.operation;
		if (!operation) throw new Error("Missing reconciliation checkpoint");
		if (operation.phase === "captured") {
			if (operation.identity || record.baseline !== operation.head)
				integrationIdentityEnv(operation.identity);
			const current = git(["rev-parse", "HEAD"]);
			const indexTree = git(["write-tree"]);
			if (
				![operation.head, operation.work].includes(current) ||
				![
					git(["rev-parse", `${operation.index}^{tree}`]),
					git(["rev-parse", `${operation.work}^{tree}`]),
				].includes(indexTree)
			)
				throw new Error(
					"Checkout changed after its checkpoint; new local work and recovery refs were retained",
				);
			// read-tree changes only the index; the worktree already has this exact tree.
			git(["read-tree", operation.work]);
			if (current !== operation.work)
				git(["update-ref", `refs/heads/${input.workBranch}`, operation.work, operation.head]);
			operation.phase = "rebasing";
			save(record);
		}
		if (operation.phase === "rebasing") {
			const conflicts = (): ReconciliationResult => ({
				status: "conflicts",
				remoteHead: operation.remote,
				headSha: git(["rev-parse", "HEAD"]),
				changed: true,
			});
			if (rebaseActive()) return conflicts();
			// Retry after Git completed the rebase but before the result was journaled.
			if (git(["rev-parse", "HEAD"]) === operation.work) {
				try {
					git(
						[
							"-c",
							"core.hooksPath=/dev/null",
							"-c",
							"commit.gpgSign=false",
							"rebase",
							"--rebase-merges",
							"--reapply-cherry-picks",
							"--empty=keep",
							"--onto",
							operation.remote,
							record.baseline,
						],
						{
							GIT_COMMITTER_NAME: operation.identity?.name ?? "Leitwerk checkpoint",
							GIT_COMMITTER_EMAIL: operation.identity?.email ?? "checkpoint@leitwerk.invalid",
						},
					);
				} catch (error) {
					if (!rebaseActive()) throw error;
					return conflicts();
				}
			}
			if (
				git(["log", "-1", "--format=%s"]) !== `Leitwerk worktree checkpoint ${operation.id}` ||
				git(["log", "-1", "--format=%s", "HEAD^"]) !== `Leitwerk index checkpoint ${operation.id}`
			)
				throw new Error(
					"Reconciliation checkpoint commits were changed or skipped; recovery refs were retained",
				);
			operation.resultHead = git(["rev-parse", "HEAD~2"]);
			operation.resultIndex = git(["rev-parse", "HEAD~1^{tree}"]);
			// Preserve the integrated working tree/index before removing checkpoint commits.
			git(["update-ref", `refs/leitwerk/reconciled/${operation.id}`, git(["rev-parse", "HEAD"])]);
			operation.phase = "restoring";
			save(record);
		}
		if (!operation.resultHead || !operation.resultIndex)
			throw new Error("Incomplete reconciliation result");
		if (record.joinParent && !ancestor(git, record.joinParent, operation.resultHead)) {
			// The net repair was replayed against the current source. Retain the target
			// ancestry without re-merging (and thereby losing the replayed resolution).
			operation.resultHead = git(
				[
					"commit-tree",
					git(["rev-parse", `${operation.resultHead}^{tree}`]),
					"-p",
					operation.resultHead,
					"-p",
					record.joinParent,
					"-m",
					"Integrate target branch with concurrent source changes",
				],
				integrationIdentityEnv(record.joinIdentity),
			);
			git([
				"update-ref",
				`refs/leitwerk/target-integrations/${operation.id}`,
				operation.resultHead,
			]);
			save(record);
		}
		const integrated = git(["rev-parse", `refs/leitwerk/reconciled/${operation.id}`]);
		const currentHead = git(["rev-parse", "HEAD"]);
		const currentIndex = git(["write-tree"]);
		if (
			![operation.resultHead, integrated].includes(currentHead) ||
			![operation.resultIndex, git(["rev-parse", `${integrated}^{tree}`])].includes(currentIndex)
		)
			throw new Error(
				"Checkout changed during interrupted restoration; local work and recovery refs were retained",
			);
		git(["update-ref", `refs/heads/${input.workBranch}`, operation.resultHead, currentHead]);
		git(["read-tree", operation.resultIndex]);
		record.baseline = operation.remote;
		delete record.operation;
		delete record.joinParent;
		delete record.joinIdentity;
		save(record);
		assertIgnoredProtection(git, record.protectedIgnored);
		return {
			status: "ready",
			remoteHead: operation.remote,
			headSha: operation.resultHead,
			changed: true,
		};
	});
}

/** Reject ignored-file collisions before a target checkout/rebase can overwrite them. @internal */
export function assertReconciliationTargetSafe(
	input: Pick<ReconciliationInput, "repoPath" | "projectKey">,
	targetSha: string,
): void {
	const { git, read } = repository(input);
	assertIgnoredProtection(git, read()?.protectedIgnored);
	if (ignoredPathsCollide(git, ignoredPaths(git), targetSha, `${targetSha}..HEAD`))
		throw new Error("Target changes collide with ignored files; local files were retained");
}

/** Preserve a target rebase as a net local delta when its source lease changes. @internal */
export function retainConcurrentRebase(
	input: ReconciliationInput & {
		rebasedHead: string;
		targetBase: string;
		gitIdentity: GitIdentity;
	},
): void {
	const { git, directory, read, save, binding: readBinding } = repository(input);
	withLock(directory, () => {
		const old = read();
		if (old?.operation || old?.sourceIntegration)
			throw new Error("Source reconciliation is already in progress");
		if (
			git(["branch", "--show-current"]) !== input.workBranch ||
			git(["rev-parse", "HEAD"]) !== input.rebasedHead ||
			git(["status", "--porcelain"])
		)
			throw new Error(
				"Target rebase changed before source reconciliation; local work was retained",
			);
		const binding = readBinding(input.workBranch);
		if (!repositoryBindingMatches(old, binding))
			throw new Error("Repository reconciliation binding changed");
		const identity = integrationIdentityEnv(input.gitIdentity);
		const id = randomUUID();
		git(["update-ref", `refs/leitwerk/target-repairs/${id}`, input.rebasedHead]);
		const replacement = git(
			[
				"commit-tree",
				git(["rev-parse", `${input.rebasedHead}^{tree}`]),
				"-p",
				input.baselineSha,
				"-m",
				"Reconcile target-branch repair",
			],
			identity,
		);
		git(["update-ref", `refs/leitwerk/target-deltas/${id}`, replacement]);
		// The original source tree is the merge baseline, not the old target branch.
		// This preserves developer deletions as well as the agent's conflict resolution.
		save({
			...binding,
			baseline: input.baselineSha,
			remoteSeen: true,
			joinParent: input.targetBase,
			joinIdentity: input.gitIdentity,
			protectedIgnored: old?.protectedIgnored,
			publicationReceiptSha: old?.publicationReceiptSha,
			sourceIntegration: { previous: input.rebasedHead, replacement },
		});
	});
}

/** @internal */
export function repositoryWorktreeIsDirty(
	input: Pick<ReconciliationInput, "repoPath" | "projectKey">,
): boolean {
	return Boolean(repository(input).git(["status", "--porcelain"]));
}

/** Capture the baseline before the first implementation, including an unpublished branch. @internal */
export function prepareInitialRepository(
	input: Omit<ReconciliationInput, "baselineSha">,
): ReconciliationResult {
	const { git, read, save, directory, binding } = repository(input);
	withLock(directory, () => {
		if (!read())
			save({
				...binding(input.workBranch),
				baseline: git(["rev-parse", "HEAD"]),
				protectedIgnored: ignoredPaths(git),
			});
	});
	return reconcilePublicationRepository(input);
}

/** Missing branches are allowed only before first publication. @internal */
export function reconcilePublicationRepository(
	input: Omit<ReconciliationInput, "baselineSha"> & { baselineSha?: string },
): ReconciliationResult {
	const { git, read, directory } = repository(input);
	const record = read();
	const receipt = readPublicationReceipt(directory);
	const baselineSha =
		record?.baseline ??
		input.baselineSha ??
		(receipt?.status === "accepted"
			? receipt.candidate
			: (receipt?.expectedHead ??
				(receipt?.status === "attempting" ? receipt.candidate : undefined)));
	assertIgnoredProtection(git, record?.protectedIgnored);
	const remote = git(["ls-remote", "--heads", "origin", `refs/heads/${input.workBranch}`]).split(
		/\s+/,
	)[0];
	if (
		!remote &&
		!input.baselineSha &&
		!record?.remoteSeen &&
		!record?.operation &&
		(!receipt || (receipt.status === "rejected" && receipt.expectedHead === null))
	)
		return {
			status: "ready",
			remoteHead: null,
			headSha: git(["rev-parse", "HEAD"]),
			changed: false,
		};
	if (!remote)
		throw new Error(
			"Remote source branch is missing or its publication is uncertain; local work was retained and the branch will not be recreated automatically",
		);
	if (!baselineSha)
		throw new Error("Cannot establish the retained work baseline; local work was retained");
	return reconcileRepository({ ...input, baselineSha });
}

/** Record only a remotely verified publication, including recovery after a lost reply. @internal */
export function recordRepositoryPublication(input: ReconciliationInput, headSha: string): void {
	const { directory, read, save, binding: readBinding } = repository(input);
	withLock(directory, () => {
		const old = read();
		if (old?.operation) throw new Error("Cannot acknowledge publication during reconciliation");
		const binding = readBinding(input.workBranch);
		if (!repositoryBindingMatches(old, binding))
			throw new Error("Repository reconciliation binding changed");
		save({
			...binding,
			baseline: headSha,
			publicationReceiptSha: headSha,
			remoteSeen: true,
			protectedIgnored: old?.protectedIgnored,
		});
	});
}

/** @internal */
export const reconciliationPrompt = `Repository synchronization preserves the current remote source branch and unpublished local work. If preparation left a rebase in progress, inspect git status and .git/leitwerk-reconciliation.json. Resolve conflicts preserving both intended changes and the original authors/sign-offs, then git add and GIT_EDITOR=true git rebase --continue until complete. Use the captured operation.identity for the committer when continuing, if present. Do not skip commits, remove the two Leitwerk checkpoint commits, reset, abort, or push. Checkpoint commits will be removed automatically by delivery; do not amend them. After resolving, finish with the turn's required success outcome so delivery can restore the ordinary checkout and request validation. If blocked, use cannot_repair when available or abort_turn otherwise, and retain the checkout. When no rebase is active, perform the requested adjustment and validate the combined result against the current repository instructions before the required success outcome. Never publish without validation after reconciliation.`;
