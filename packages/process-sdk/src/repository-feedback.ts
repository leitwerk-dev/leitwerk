import { asUnknownRecord } from "@leitwerk-dev/domain";

/** @public */
export interface RepositoryFeedbackItem {
	/** @public */
	kind: "conversation" | "review" | "inline";
	/** @internal */
	id: number;
	/** @public */
	body: string;
	/** @internal */
	createdAt: string;
	/** @public */
	author: string;
	/** @internal */
	path?: string;
	/** @internal */
	line?: number | null;
}

/** Batch already-authorized, unseen feedback after its quiet period. */
/** @internal */
export function repositoryFeedbackBatch(
	unseen: readonly RepositoryFeedbackItem[],
	config: Record<`${RepositoryFeedbackItem["kind"]}Cursor`, number> & {
		/** @internal */
		quietPeriodMs: number;
	},
	now: number,
) {
	if (!unseen.length) return null;
	const latest = Math.max(...unseen.map((item) => Date.parse(item.createdAt) || 0));
	if (now - latest < config.quietPeriodMs) return null;
	const cursors = {
		/** @internal */
		conversationCursor: config.conversationCursor,
		/** @internal */
		reviewCursor: config.reviewCursor,
		/** @internal */
		inlineCursor: config.inlineCursor,
	};
	for (const item of unseen) {
		const key = `${item.kind}Cursor` as const;
		cursors[key] = Math.max(cursors[key], item.id);
	}
	return {
		/** @internal */
		event: {
			/** @internal */
			feedbackIds: unseen.map(({ kind, id }) => ({
				/** @internal */
				kind,
				/** @internal */
				id,
			})),
			/** @internal */
			cursors,
		},
		/** @internal */
		mergeKey: `${cursors.conversationCursor}:${cursors.reviewCursor}:${cursors.inlineCursor}`,
	};
}

/** Normalize common forge feedback fields; reject empty bodies and missing identities. */
/** @internal */
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
