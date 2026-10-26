import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repositoryGitArgs, repositoryGitSubprocessEnv } from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import {
	pushWasRejected,
	type RepositoryPublicationReceipt,
	readPublicationReceipt,
	readRepositoryBinding,
	repositoryBindingMatches,
	savePublicationReceipt,
} from "../repository-publication-receipt.js";
import { assertReconciliationTargetSafe } from "../repository-reconciliation.js";
import { repositoryRecord } from "../repository-record.js";

import { type ConflictEvidence, conflictKey } from "./index.js";
import {
	type RebaseRecord,
	requireRebaseHead,
	requireRebaseOrigin,
	requireRebaseTarget,
	requireRebaseWorktree,
} from "./policy.js";

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
const recordFile = (gitDir: string) => repositoryRecord<RebaseRecord>(gitDir, "rebase");
function requireWorktree(input: RebaseInput): void {
	requireRebaseWorktree(input.workBranch, {
		branch: git(input, "branch", "--show-current"),
		dirty: Boolean(git(input, "status", "--porcelain")),
	});
}
function remoteHead(input: RebaseInput): string {
	return git(input, "ls-remote", "--heads", "origin", `refs/heads/${input.workBranch}`).split(
		/\s+/,
	)[0];
}

function requireTarget(input: RebaseInput, record?: RebaseRecord | null): void {
	requireRebaseTarget(input.workBranch, input.conflict, record);
	git(input, "check-ref-format", `refs/heads/${input.workBranch}`);
	git(input, "check-ref-format", `refs/heads/${input.conflict.baseBranch}`);
	requireRebaseOrigin(record, {
		originUrl: record?.originUrl ? git(input, "remote", "get-url", "origin") : undefined,
		originPushUrl: record?.originPushUrl
			? git(input, "remote", "get-url", "--push", "--all", "origin")
			: undefined,
	});
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

/** @internal */
export function hasPreparedRebase(input: RebaseInput): boolean {
	return recordFile(area(input)).read()?.key === conflictKey(input.conflict);
}

/** Persist the lease before changing HEAD; a retry resumes Git's own rebase state. @internal */
export function prepareRebase(input: RebaseInput): RebaseRecord {
	const gitDir = area(input);
	const old = recordFile(gitDir).read();
	requireTarget(input, old?.key === conflictKey(input.conflict) ? old : null);
	if (old?.key === conflictKey(input.conflict)) {
		verifyCurrentBase(input, old);
		return old;
	}
	if (active(gitDir)) throw new Error("An unrelated rebase is already in progress");
	requireWorktree(input);
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
	requireRebaseHead(input.conflict.headSha, headSha, remoteSha);
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
	recordFile(gitDir).save(record);
	return record;
}
/** @internal */
export function startRebase(input: RebaseInput): RebaseRecord {
	const record = prepareRebase(input);
	const gitDir = area(input);
	if (active(gitDir)) return record;
	if (record.status === "clean") return record;
	requireWorktree(input);
	if (record.status === "rebasing" && git(input, "rev-parse", "HEAD") !== record.originalHead)
		return record;
	try {
		verifyNoRepairNeeded(input, record.originalHead, record.baseSha);
		record.status = "clean";
		recordFile(gitDir).save(record);
		return record;
	} catch (error) {
		if ((error as { status?: number }).status !== 1) throw error;
	}
	assertReconciliationTargetSafe(
		{ projectKey: input.projectKey, repoPath: input.path },
		record.baseSha,
	);
	record.status = "rebasing";
	recordFile(gitDir).save(record);
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
	const record = recordFile(gitDir).read();
	if (!record || record.key !== conflictKey(input.conflict))
		throw new Error("Missing matching rebase metadata");
	requireTarget(input, record);
	if (active(gitDir)) throw new Error("Rebase is incomplete");
	requireWorktree(input);
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
export class ConcurrentRebaseSourceError extends Error {
	constructor(
		readonly repair: ReturnType<typeof verifyRebase>,
		readonly published = false,
	) {
		super("Concurrent remote change rejected by rebase lease; local repair was retained");
	}
}

/** @internal */
export function publishRebase(input: RebaseInput): ReturnType<typeof verifyRebase> {
	const result = verifyRebase(input);
	assertReconciliationTargetSafe(
		{ projectKey: input.projectKey, repoPath: input.path },
		result.baseSha,
	);
	const gitDir = area(input);
	const record = recordFile(gitDir).read();
	if (!record) throw new Error("Missing matching rebase metadata");
	verifyCurrentBase(input, record);
	const remote = remoteHead(input);
	const binding = readRepositoryBinding((...args) => git(input, ...args), input.workBranch);
	if (binding.origin !== binding.pushOrigin)
		throw new Error("Fetch and push endpoints must match for publication");
	const previous = readPublicationReceipt(gitDir);
	if (!repositoryBindingMatches(previous, binding))
		throw new Error("Repository publication receipt binding changed");
	const receipt: RepositoryPublicationReceipt = {
		...binding,
		expectedHead: result.originalHead,
		candidate: result.headSha,
		status: "attempting",
	};
	if (remote === result.headSha) {
		savePublicationReceipt(gitDir, { ...receipt, status: "accepted" });
		return result;
	}
	if (previous?.candidate === result.headSha && previous.status === "accepted")
		throw new ConcurrentRebaseSourceError(result, true);
	if (previous?.status === "attempting") {
		git(
			input,
			"fetch",
			"--no-tags",
			"origin",
			`+refs/heads/${input.workBranch}:refs/leitwerk/rebase-publication-proof`,
		);
		try {
			git(
				input,
				"merge-base",
				"--is-ancestor",
				previous.candidate,
				"refs/leitwerk/rebase-publication-proof",
			);
		} catch {
			throw new Error(
				"Prior target publication outcome is uncertain; local repair was retained for operator reconciliation",
			);
		}
		savePublicationReceipt(gitDir, { ...previous, status: "accepted" });
		throw new ConcurrentRebaseSourceError(result, previous.candidate === result.headSha);
	}
	if (remote !== result.originalHead) throw new ConcurrentRebaseSourceError(result);
	savePublicationReceipt(gitDir, receipt);
	try {
		git(
			input,
			"push",
			"--porcelain",
			"--no-follow-tags",
			"--recurse-submodules=no",
			`--force-with-lease=refs/heads/${input.workBranch}:${result.originalHead}`,
			"origin",
			`${result.headSha}:refs/heads/${input.workBranch}`,
		);
	} catch (error) {
		const rejected = pushWasRejected((error as { stdout?: Buffer }).stdout?.toString() ?? "");
		if (rejected) savePublicationReceipt(gitDir, { ...receipt, status: "rejected" });
		const latest = remoteHead(input);
		if (latest === result.headSha) {
			savePublicationReceipt(gitDir, { ...receipt, status: "accepted" });
			return result;
		}
		if (rejected && latest !== result.originalHead) throw new ConcurrentRebaseSourceError(result);
		throw error;
	}
	savePublicationReceipt(gitDir, { ...receipt, status: "accepted" });
	if (remoteHead(input) !== result.headSha) throw new ConcurrentRebaseSourceError(result, true);
	return result;
}
