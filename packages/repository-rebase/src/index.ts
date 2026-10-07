import type {
	createExternalSourcePollReporter,
	ExternalEventDescription,
	ExternalObservationInput,
	ExternalSourceArmingLike,
	ExternalSourceServiceLike,
	RepositoryPullRequest,
} from "@leitwerk-dev/process-sdk";

/** @public */
export interface ConflictEvidence {
	/** @public */
	reason?: "behind";
	/** @public */
	owner: string;
	/** @public */
	repo: string;
	/** @public */
	prNumber: number;
	/** @public */
	headBranch: string;
	/** @public */
	baseBranch: string;
	/** @public */
	headSha: string;
	/** @public */
	baseSha: string;
	/** @public */
	url: string;
}
/** @public */
export function conflictKey(value: ConflictEvidence): string {
	return JSON.stringify([value.owner, value.repo, value.prNumber, value.headSha, value.baseSha]);
}
/** @public */
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
/** @internal */
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
/** @internal */
export function conflictEvidence(
	config: {
		/** @internal */
		owner: string;
		/** @internal */
		repo: string;
		/** @internal */
		prNumber: number;
		/** @internal */
		headSha: string;
	},
	pr: Pick<
		RepositoryPullRequest,
		"number" | "state" | "merged" | "mergeable" | "mergeable_state" | "head" | "base" | "html_url"
	>,
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

/** Observe every refresh; fire each conflict pair once per live subscription. */
/** @internal */
export function createConflictReporter(sources: ExternalSourceServiceLike, kind: string) {
	const accepted = new Map<string, string>();
	return async (
		report: ReturnType<typeof createExternalSourcePollReporter>,
		armed: ExternalSourceArmingLike,
		conflict: ConflictEvidence | null,
		lastKey: unknown,
		observation: NonNullable<ExternalObservationInput["observation"]>,
	): Promise<boolean> => {
		await report.observe(armed, {
			observation: { ...observation, ...(conflict ? describeConflict({ conflict }) : {}) },
		});
		if (!conflict) return false;
		const pair = conflictKey(conflict);
		const key = `${armed.instanceId}:${armed.id}:${armed.generation ?? ""}`;
		if (
			pair === lastKey ||
			accepted.get(key) === pair ||
			!sources.listArmed(kind).some((current) => sameSubscription(armed, current))
		)
			return false;
		if (await report.fire(armed, { kind: "merge_conflict", conflict }, pair))
			accepted.set(key, pair);
		return true;
	};
}

/** A captured generation and resolved identity must still be armed after provider I/O. */
/** @internal */
export function sameSubscription(
	captured: {
		/** @internal */
		id: string;
		/** @internal */
		instanceId: string;
		/** @internal */
		generation?: string;
		/** @internal */
		resolved: unknown;
	},
	current: {
		/** @internal */
		id: string;
		/** @internal */
		instanceId: string;
		/** @internal */
		generation?: string;
		/** @internal */
		resolved: unknown;
	},
): boolean {
	return (
		current.id === captured.id &&
		current.instanceId === captured.instanceId &&
		current.generation === captured.generation &&
		JSON.stringify(current.resolved) === JSON.stringify(captured.resolved)
	);
}
