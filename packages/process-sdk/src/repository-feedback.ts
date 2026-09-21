import { asUnknownRecord } from "@leitwerk-dev/domain";

/** @public */
export interface RepositoryFeedbackItem {
	/** @public */
	kind: "conversation" | "review" | "inline";
	/** @public */
	id: number;
	/** @public */
	body: string;
	/** @public */
	createdAt: string;
	/** @public */
	author: string;
	/** @public */
	path?: string;
	/** @public */
	line?: number | null;
}

/** Batch already-authorized, unseen feedback after its quiet period. @public */
export function repositoryFeedbackBatch(
	unseen: readonly RepositoryFeedbackItem[],
	config: RepositoryFeedbackBatchConfig,
	now: number,
): RepositoryFeedbackBatch | null {
	if (!unseen.length) return null;
	const latest = Math.max(...unseen.map((item) => Date.parse(item.createdAt) || 0));
	if (now - latest < config.quietPeriodMs) return null;
	const cursors = {
		/** @public */
		conversationCursor: config.conversationCursor,
		/** @public */
		reviewCursor: config.reviewCursor,
		/** @public */
		inlineCursor: config.inlineCursor,
	};
	for (const item of unseen) {
		const key = `${item.kind}Cursor` as const;
		cursors[key] = Math.max(cursors[key], item.id);
	}
	return {
		/** @public */
		event: {
			/** @public */
			feedbackIds: unseen.map(({ kind, id }) => ({
				/** @public */
				kind,
				/** @public */
				id,
			})),
			/** @public */
			cursors,
		},
		/** @public */
		mergeKey: `${cursors.conversationCursor}:${cursors.reviewCursor}:${cursors.inlineCursor}`,
	};
}

/** Normalize common forge feedback fields; reject empty bodies and missing identities. @public */
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
/** @public */
export interface RepositoryFeedbackCursors {
	/** @public */
	conversationCursor: number;
	/** @public */
	reviewCursor: number;
	/** @public */
	inlineCursor: number;
}
/** @public */
export interface RepositoryFeedbackBatchConfig extends RepositoryFeedbackCursors {
	/** @public */
	quietPeriodMs: number;
}
/** @public */
export interface RepositoryFeedbackBatch {
	/** @public */
	event: {
		/** @public */
		feedbackIds: {
			/** @public */
			kind: RepositoryFeedbackItem["kind"];
			/** @public */
			id: number;
		}[];
		/** @public */
		cursors: RepositoryFeedbackCursors;
	};
	/** @public */
	mergeKey: string;
}
