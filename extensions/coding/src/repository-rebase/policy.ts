import type { ConflictEvidence } from "./index.js";

/** Durable preparation evidence; optional identity fields support older records. @internal */
export interface RebaseRecord {
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
	/** @internal */
	originUrl?: string;
	/** @internal */
	originPushUrl?: string;
	/** @internal */
	baseBranch?: string;
}

/** Validate provider evidence against the tracked branch and retained preparation. @internal */
export function requireRebaseTarget(
	workBranch: string,
	conflict: ConflictEvidence,
	record?: RebaseRecord | null,
): void {
	if (workBranch !== conflict.headBranch || workBranch === conflict.baseBranch)
		throw new Error("Expected evidence for the tracked work branch and a distinct base");
	if (record && (record.branch !== workBranch || record.originalHead !== conflict.headSha))
		throw new Error("Missing matching rebase metadata");
	if (record?.baseBranch && record.baseBranch !== conflict.baseBranch)
		throw new Error("Rebase base branch changed since preparation");
}

/** Compare observed remote identity only where preparation retained it. @internal */
export function requireRebaseOrigin(
	record: RebaseRecord | null | undefined,
	origin: { originUrl?: string; originPushUrl?: string },
): void {
	if (
		(record?.originUrl && origin.originUrl !== record.originUrl) ||
		(record?.originPushUrl && origin.originPushUrl !== record.originPushUrl)
	)
		throw new Error("Rebase origin changed since preparation");
}

/** A repair may operate only on the clean tracked checkout. @internal */
export function requireRebaseWorktree(
	workBranch: string,
	observation: { branch: string; dirty: boolean },
): void {
	if (observation.branch !== workBranch) throw new Error("Expected tracked work branch for rebase");
	if (observation.dirty)
		throw new Error("Rebase requires a clean worktree with no unresolved conflicts");
}

/** Both local and remote heads must still match the provider's evidence. @internal */
export function requireRebaseHead(expected: string, local: string, remote: string): void {
	if (remote !== expected || local !== expected)
		throw new Error("Tracked branch changed before repair");
}

/** Recognize a completed write without accepting somebody else's remote update. @internal */
export function rebasePublicationDecision(
	originalHead: string,
	headSha: string,
	remoteHead: string,
): "already_published" | "push" {
	if (remoteHead === headSha) return "already_published";
	if (remoteHead !== originalHead)
		throw new Error("Concurrent remote change rejected by rebase lease");
	return "push";
}
