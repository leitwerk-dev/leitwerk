import { describe, expect, it } from "vitest";
import {
	createReviewSubject,
	isReviewSubjectKind,
	parseReviewSubject,
	REVIEW_SUBJECT_KINDS,
} from "./review-subject.js";

describe("review subject", () => {
	it("recognizes the accepted review subject kinds", () => {
		for (const kind of REVIEW_SUBJECT_KINDS) {
			expect(isReviewSubjectKind(kind)).toBe(true);
		}
		expect(isReviewSubjectKind("review_findings")).toBe(false);
		expect(isReviewSubjectKind("review_result")).toBe(false);
	});

	it("creates review subject objects", () => {
		expect(createReviewSubject("implementation")).toEqual({ kind: "implementation" });
	});

	it("parses known review subject objects", () => {
		expect(parseReviewSubject({ kind: "plan" })).toEqual({ kind: "plan" });
		expect(parseReviewSubject({ kind: "implementation" })).toEqual({ kind: "implementation" });
	});

	it.each([
		null,
		undefined,
		true,
		1,
		"plan",
		[],
		{ kind: "review_result" },
		{ kind: "" },
	])("returns null for invalid review subject input %j", (value) => {
		expect(parseReviewSubject(value)).toBeNull();
	});
});
