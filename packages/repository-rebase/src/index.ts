import type { ExternalEventDescription } from "@leitwerk-dev/process-sdk";

export interface ConflictEvidence {
	reason?: "behind";
	owner: string;
	repo: string;
	prNumber: number;
	headBranch: string;
	baseBranch: string;
	headSha: string;
	baseSha: string;
	url: string;
}
export function conflictKey(value: ConflictEvidence): string {
	return JSON.stringify([value.owner, value.repo, value.prNumber, value.headSha, value.baseSha]);
}
export function validateConflict(
	value: unknown,
	expected: Omit<ConflictEvidence, "baseSha" | "url">,
	lastKey?: string | null,
): ConflictEvidence {
	const evidence = value as ConflictEvidence | null;
	if (
		!evidence ||
		typeof evidence !== "object" ||
		Array.isArray(evidence) ||
		["owner", "repo", "headBranch", "baseBranch", "headSha", "baseSha"].some(
			(key) =>
				typeof evidence[key as keyof ConflictEvidence] !== "string" ||
				!String(evidence[key as keyof ConflictEvidence]).trim(),
		) ||
		!Number.isSafeInteger(evidence.prNumber) ||
		evidence.prNumber <= 0 ||
		(evidence.reason !== undefined && evidence.reason !== "behind") ||
		Object.entries(expected).some(
			([key, val]) => evidence[key as keyof ConflictEvidence] !== val,
		) ||
		!/^[a-f0-9]{40,64}$/i.test(evidence.baseSha) ||
		!/^[a-f0-9]{40,64}$/i.test(evidence.headSha) ||
		typeof evidence.url !== "string" ||
		conflictKey(evidence) === lastKey
	)
		throw new Error("Stale or invalid pull request conflict evidence");
	return evidence;
}
export function describeConflict(event: unknown): ExternalEventDescription {
	const evidence = (event as { conflict: ConflictEvidence }).conflict;
	return {
		summary: `${evidence.reason === "behind" ? "Pull request behind base in" : "Merge conflict in"} ${evidence.owner}/${evidence.repo}#${evidence.prNumber}: ${evidence.headBranch} (${evidence.headSha}) against ${evidence.baseBranch} (${evidence.baseSha})`,
		links: [
			{
				id: "conflicting-pr",
				label: `PR #${evidence.prNumber}`,
				url: evidence.url,
				kind: "pull_request",
			},
		],
	};
}
export function conflictEvidence(
	config: { owner: string; repo: string; prNumber: number; headSha: string },
	pr: {
		number: number;
		state: string;
		merged: boolean;
		mergeable?: boolean | null;
		mergeable_state?: string | null;
		head: { ref: string; sha: string };
		base: { ref: string; sha: string };
		html_url: string;
	},
	provider: "github" | "forgejo",
): ConflictEvidence | null {
	const behind = provider === "github" && pr.mergeable === true && pr.mergeable_state === "behind";
	const conflicting =
		pr.mergeable === false && (provider === "forgejo" || pr.mergeable_state === "dirty");
	if (
		pr.number !== config.prNumber ||
		pr.state !== "open" ||
		pr.merged ||
		pr.head.sha !== config.headSha ||
		(!behind && !conflicting) ||
		!pr.base?.sha
	)
		return null;
	return {
		...(behind ? { reason: "behind" as const } : {}),
		owner: config.owner,
		repo: config.repo,
		prNumber: pr.number,
		headBranch: pr.head.ref,
		baseBranch: pr.base.ref,
		headSha: pr.head.sha,
		baseSha: pr.base.sha,
		url: pr.html_url,
	};
}

/** A captured generation and resolved identity must still be armed after provider I/O. */
export function sameSubscription(
	captured: { id: string; instanceId: string; generation?: string; resolved: unknown },
	current: { id: string; instanceId: string; generation?: string; resolved: unknown },
): boolean {
	return (
		current.id === captured.id &&
		current.instanceId === captured.instanceId &&
		current.generation === captured.generation &&
		JSON.stringify(current.resolved) === JSON.stringify(captured.resolved)
	);
}
