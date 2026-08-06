export const REVIEW_SUBJECT_KINDS = ["plan", "implementation"] as const;

export type ReviewSubjectKind = (typeof REVIEW_SUBJECT_KINDS)[number];

export interface ReviewSubject {
	kind: ReviewSubjectKind;
}

export function isReviewSubjectKind(value: string): value is ReviewSubjectKind {
	return (REVIEW_SUBJECT_KINDS as readonly string[]).includes(value);
}

export function createReviewSubject(kind: ReviewSubjectKind): ReviewSubject {
	return { kind };
}

export function parseReviewSubject(value: unknown): ReviewSubject | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.kind !== "string" || !isReviewSubjectKind(record.kind)) {
		return null;
	}
	return { kind: record.kind };
}
