import { asUnknownRecord } from "@leitwerk-dev/domain";

export interface RepositoryFeedbackItem {
	kind: "conversation" | "review" | "inline";
	id: number;
	body: string;
	createdAt: string;
	author: string;
	path?: string;
	line?: number | null;
}

/** Batch already-authorized, unseen feedback after its quiet period. */
export function repositoryFeedbackBatch(
	unseen: readonly RepositoryFeedbackItem[],
	config: Record<`${RepositoryFeedbackItem["kind"]}Cursor`, number> & { quietPeriodMs: number },
	now: number,
) {
	if (!unseen.length) return null;
	const latest = Math.max(...unseen.map((item) => Date.parse(item.createdAt) || 0));
	if (now - latest < config.quietPeriodMs) return null;
	const cursors = {
		conversationCursor: config.conversationCursor,
		reviewCursor: config.reviewCursor,
		inlineCursor: config.inlineCursor,
	};
	for (const item of unseen) {
		const key = `${item.kind}Cursor` as const;
		cursors[key] = Math.max(cursors[key], item.id);
	}
	return {
		event: { feedbackIds: unseen.map(({ kind, id }) => ({ kind, id })), cursors },
		mergeKey: `${cursors.conversationCursor}:${cursors.reviewCursor}:${cursors.inlineCursor}`,
	};
}

/** Normalize common forge feedback fields; reject empty bodies and missing identities. */
export function normalizeRepositoryFeedback(
	kind: RepositoryFeedbackItem["kind"],
	item: Record<string, unknown>,
): RepositoryFeedbackItem | null {
	const body = typeof item.body === "string" ? item.body.trim() : "";
	const user = asUnknownRecord(item.user) ?? {};
	if (!body || typeof item.id !== "number" || typeof user.login !== "string") return null;
	return {
		kind,
		id: item.id,
		body,
		createdAt:
			typeof item.submitted_at === "string"
				? item.submitted_at
				: typeof item.created_at === "string"
					? item.created_at
					: new Date(0).toISOString(),
		author: user.login,
		...(typeof item.path === "string" ? { path: item.path } : {}),
		...(typeof item.line === "number" ? { line: item.line } : {}),
	};
}
