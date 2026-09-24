import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryGitArgs, repositoryGitSubprocessEnv } from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";

import { type ConflictEvidence, conflictKey } from "./index.js";

/** @internal */
export interface RebaseInput {
	/** @internal */
	projectKey: string;
	/** @internal */
	path: string;
	/** @internal */
	workBranch: string;
	/** @internal */
	conflict: ConflictEvidence;
}
/** @internal */
interface RebaseRecord {
	/** @internal */
	key: string;
	/** @internal */
	branch: string;
	/** @internal */
	originalHead: string;
	/** @internal */
	baseSha: string;
	/** @internal */
	status: "prepared" | "rebasing" | "clean";
	/** Optional for records written before origin identity was retained. @internal */
	originUrl?: string;
	/** @internal */
	originPushUrl?: string;
	/** @internal */
	baseBranch?: string;
}
function git(input: RebaseInput, ...args: string[]): string {
	return execFileSync(resolveGitBinary(), repositoryGitArgs(args), {
		cwd: input.path,
		encoding: "utf8",
		env: repositoryGitSubprocessEnv(input.projectKey, {
			GIT_TERMINAL_PROMPT: "0",
			GIT_EDITOR: "true",
		}),
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
function area(input: RebaseInput): string {
	return git(input, "rev-parse", "--absolute-git-dir");
}
function active(gitDir: string): boolean {
	return ["rebase-merge", "rebase-apply"].some((name) => existsSync(join(gitDir, name)));
}
function save(gitDir: string, record: RebaseRecord): void {
	const path = join(gitDir, "leitwerk-rebase.json");
	writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}
function read(gitDir: string): RebaseRecord | null {
	const file = join(gitDir, "leitwerk-rebase.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RebaseRecord) : null;
}
function requireBranch(input: RebaseInput): void {
	if (git(input, "branch", "--show-current") !== input.workBranch)
		throw new Error("Expected tracked work branch for rebase");
}
function requireClean(input: RebaseInput): void {
	if (git(input, "status", "--porcelain"))
		throw new Error("Rebase requires a clean worktree with no unresolved conflicts");
}
function remoteHead(input: RebaseInput): string {
	return git(input, "ls-remote", "--heads", "origin", `refs/heads/${input.workBranch}`).split(
		/\s+/,
	)[0];
}

function requireTarget(input: RebaseInput, record?: RebaseRecord | null): void {
	if (
		input.workBranch !== input.conflict.headBranch ||
		input.workBranch === input.conflict.baseBranch
	)
		throw new Error("Expected evidence for the tracked work branch and a distinct base");
	git(input, "check-ref-format", `refs/heads/${input.workBranch}`);
	git(input, "check-ref-format", `refs/heads/${input.conflict.baseBranch}`);
	if (
		record &&
		(record.branch !== input.workBranch || record.originalHead !== input.conflict.headSha)
	)
		throw new Error("Missing matching rebase metadata");
	if (record?.originUrl && git(input, "remote", "get-url", "origin") !== record.originUrl)
		throw new Error("Rebase origin changed since preparation");
	if (
		record?.originPushUrl &&
		git(input, "remote", "get-url", "--push", "--all", "origin") !== record.originPushUrl
	)
		throw new Error("Rebase origin changed since preparation");
	if (record?.baseBranch && record.baseBranch !== input.conflict.baseBranch)
		throw new Error("Rebase base branch changed since preparation");
}

function verifyCurrentBase(input: RebaseInput, record: RebaseRecord): void {
	git(
		input,
		"fetch",
		"origin",
		`+refs/heads/${input.conflict.baseBranch}:refs/leitwerk/rebase-base`,
	);
	// A fast-forward is compatible with captured preparation; a rewritten base is not.
	git(input, "merge-base", "--is-ancestor", record.baseSha, "refs/leitwerk/rebase-base");
}

function verifyNoRepairNeeded(input: RebaseInput, headSha: string, baseSha: string): void {
	if (input.conflict.reason === "behind")
		git(input, "merge-base", "--is-ancestor", baseSha, headSha);
	else git(input, "merge-tree", "--write-tree", headSha, baseSha);
}

/** Persist the lease before changing HEAD; a retry resumes Git's own rebase state. @internal */
export function prepareRebase(input: RebaseInput): RebaseRecord {
	const gitDir = area(input);
	const old = read(gitDir);
	requireTarget(input, old?.key === conflictKey(input.conflict) ? old : null);
	if (old?.key === conflictKey(input.conflict)) {
		verifyCurrentBase(input, old);
		return old;
	}
	if (active(gitDir)) throw new Error("An unrelated rebase is already in progress");
	requireBranch(input);
	requireClean(input);
	git(
		input,
		"fetch",
		"origin",
		`+refs/heads/${input.workBranch}:refs/leitwerk/rebase-head`,
		`+refs/heads/${input.conflict.baseBranch}:refs/leitwerk/rebase-base`,
	);
	const [remoteSha, headSha, baseSha] = git(
		input,
		"rev-parse",
		"refs/leitwerk/rebase-head",
		"HEAD",
		"refs/leitwerk/rebase-base",
	).split("\n");
	if (remoteSha !== input.conflict.headSha || headSha !== input.conflict.headSha)
		throw new Error("Tracked branch changed before repair");
	// Use the current fetched base, retaining the provider pair for deduplication.
	git(input, "merge-base", "--is-ancestor", input.conflict.baseSha, baseSha);
	const record: RebaseRecord = {
		key: conflictKey(input.conflict),
		branch: input.workBranch,
		originalHead: input.conflict.headSha,
		baseSha,
		status: "prepared",
		originUrl: git(input, "remote", "get-url", "origin"),
		originPushUrl: git(input, "remote", "get-url", "--push", "--all", "origin"),
		baseBranch: input.conflict.baseBranch,
	};
	git(input, "update-ref", "refs/leitwerk/rebase-original", record.originalHead);
	save(gitDir, record);
	return record;
}
/** @internal */
export function startRebase(input: RebaseInput): RebaseRecord {
	const record = prepareRebase(input);
	const gitDir = area(input);
	if (active(gitDir)) return record;
	if (record.status === "clean") return record;
	requireBranch(input);
	requireClean(input);
	if (record.status === "rebasing" && git(input, "rev-parse", "HEAD") !== record.originalHead)
		return record;
	try {
		verifyNoRepairNeeded(input, record.originalHead, record.baseSha);
		record.status = "clean";
		save(gitDir, record);
		return record;
	} catch (error) {
		if ((error as { status?: number }).status !== 1) throw error;
	}
	record.status = "rebasing";
	save(gitDir, record);
	try {
		git(input, "rebase", "--rebase-merges", record.baseSha);
	} catch (error) {
		if (!active(gitDir)) throw error;
	}
	return record;
}
/** @internal */
export function verifyRebase(input: RebaseInput): {
	/** @internal */
	headSha: string;
	/** @internal */
	changed: boolean;
	/** @internal */
	originalHead: string;
	/** @internal */
	baseSha: string;
} {
	const gitDir = area(input);
	const record = read(gitDir);
	if (!record || record.key !== conflictKey(input.conflict))
		throw new Error("Missing matching rebase metadata");
	requireTarget(input, record);
	if (active(gitDir)) throw new Error("Rebase is incomplete");
	requireBranch(input);
	requireClean(input);
	const headSha = git(input, "rev-parse", "HEAD");
	if (record.status === "clean") {
		if (headSha !== record.originalHead)
			throw new Error("Clean conflict report must not rewrite the branch");
		verifyNoRepairNeeded(input, headSha, record.baseSha);
	} else {
		if (record.status !== "rebasing") throw new Error("Rebase was not started");
		git(input, "merge-base", "--is-ancestor", record.baseSha, headSha);
	}
	return {
		headSha,
		changed: headSha !== record.originalHead,
		originalHead: record.originalHead,
		baseSha: record.baseSha,
	};
}
/** @internal */
export function publishRebase(input: RebaseInput): ReturnType<typeof verifyRebase> {
	const result = verifyRebase(input);
	const gitDir = area(input);
	const record = read(gitDir);
	if (!record) throw new Error("Missing matching rebase metadata");
	verifyCurrentBase(input, record);
	const remote = remoteHead(input);
	if (remote === result.headSha) return result;
	if (remote !== result.originalHead)
		throw new Error("Concurrent remote change rejected by rebase lease");
	git(
		input,
		"push",
		`--force-with-lease=refs/heads/${input.workBranch}:${result.originalHead}`,
		"origin",
		`${result.headSha}:refs/heads/${input.workBranch}`,
	);
	if (remoteHead(input) !== result.headSha)
		throw new Error("Rebase publication could not be verified");
	return result;
}
