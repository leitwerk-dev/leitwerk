import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryGitArgs, repositoryGitSubprocessEnv } from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";

import { type ConflictEvidence, conflictKey } from "./index.js";

/** @public */
export interface RebaseInput {
	/** @public */
	projectKey: string;
	/** @public */
	path: string;
	/** @public */
	workBranch: string;
	/** @public */
	conflict: ConflictEvidence;
}
/** @public */
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
function active(input: RebaseInput): boolean {
	return ["rebase-merge", "rebase-apply"].some((name) => existsSync(join(area(input), name)));
}
function recordPath(input: RebaseInput): string {
	return join(area(input), "leitwerk-rebase.json");
}
function save(input: RebaseInput, record: RebaseRecord): void {
	const path = recordPath(input);
	writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}
function read(input: RebaseInput): RebaseRecord | null {
	const file = recordPath(input);
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
	const currentBase = git(input, "rev-parse", "refs/leitwerk/rebase-base");
	// A fast-forward is compatible with captured preparation; a rewritten base is not.
	git(input, "merge-base", "--is-ancestor", record.baseSha, currentBase);
}

function verifyNoRepairNeeded(input: RebaseInput, headSha: string, baseSha: string): void {
	if (input.conflict.reason === "behind")
		git(input, "merge-base", "--is-ancestor", baseSha, headSha);
	else git(input, "merge-tree", "--write-tree", headSha, baseSha);
}

/** Persist the lease before changing HEAD; a retry resumes Git's own rebase state. @internal */
export function prepareRebase(input: RebaseInput): RebaseRecord {
	const old = read(input);
	requireTarget(input, old?.key === conflictKey(input.conflict) ? old : null);
	if (old?.key === conflictKey(input.conflict)) {
		verifyCurrentBase(input, old);
		return old;
	}
	if (active(input)) throw new Error("An unrelated rebase is already in progress");
	requireBranch(input);
	requireClean(input);
	git(
		input,
		"fetch",
		"origin",
		`+refs/heads/${input.workBranch}:refs/leitwerk/rebase-head`,
		`+refs/heads/${input.conflict.baseBranch}:refs/leitwerk/rebase-base`,
	);
	if (
		git(input, "rev-parse", "refs/leitwerk/rebase-head") !== input.conflict.headSha ||
		git(input, "rev-parse", "HEAD") !== input.conflict.headSha
	)
		throw new Error("Tracked branch changed before repair");
	const baseSha = git(input, "rev-parse", "refs/leitwerk/rebase-base");
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
	save(input, record);
	return record;
}
/** @public */
export function startRebase(input: RebaseInput): RebaseRecord {
	const record = prepareRebase(input);
	if (active(input)) return record;
	if (record.status === "clean") return record;
	requireBranch(input);
	requireClean(input);
	if (record.status === "rebasing" && git(input, "rev-parse", "HEAD") !== record.originalHead)
		return record;
	try {
		verifyNoRepairNeeded(input, record.originalHead, record.baseSha);
		record.status = "clean";
		save(input, record);
		return record;
	} catch (error) {
		if ((error as { status?: number }).status !== 1) throw error;
	}
	record.status = "rebasing";
	save(input, record);
	try {
		git(input, "rebase", "--rebase-merges", record.baseSha);
	} catch (error) {
		if (!active(input)) throw error;
	}
	return record;
}
/** @public */
export function verifyRebase(input: RebaseInput): {
	/** @public */
	headSha: string;
	/** @internal */
	changed: boolean;
	/** @internal */
	originalHead: string;
	/** @internal */
	baseSha: string;
} {
	const record = read(input);
	if (!record || record.key !== conflictKey(input.conflict))
		throw new Error("Missing matching rebase metadata");
	requireTarget(input, record);
	if (active(input)) throw new Error("Rebase is incomplete");
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
/** @public */
export function publishRebase(input: RebaseInput): ReturnType<typeof verifyRebase> {
	const result = verifyRebase(input);
	const record = read(input);
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
