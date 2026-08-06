import { describe, expect, it } from "vitest";
import {
	buildPlanSavedEventPayload,
	buildReviewCompletedEventPayload,
	buildReviewRequestedEventPayload,
	filterStringArray,
} from "./review-flow.js";

describe("review-flow helpers", () => {
	it("filters string arrays without coercing other values", () => {
		expect(filterStringArray(["a", 1, null, "b", undefined])).toEqual(["a", "b"]);
		expect(filterStringArray("nope")).toEqual([]);
	});

	it("builds a saved-plan payload from turn markdown and acceptance criteria", () => {
		expect(
			buildPlanSavedEventPayload({
				planRevision: 3,
				event: {
					params: {
						summary: "Ship it",
						planMarkdown: "fallback markdown",
						acceptanceCriteria: ["one", 2, "two"],
					},
					turnResultMarkdown: "primary markdown",
				},
			}),
		).toEqual({
			planRevision: 3,
			summary: "Ship it",
			planMarkdown: "primary markdown",
			acceptanceCriteria: ["one", "two"],
		});
	});

	it("falls back to planMarkdown when turn markdown is unavailable", () => {
		expect(
			buildPlanSavedEventPayload({
				planRevision: 1,
				event: {
					params: {
						summary: "Draft",
						planMarkdown: "from params",
						acceptanceCriteria: [],
					},
					turnResultMarkdown: null,
				},
			}),
		).toMatchObject({ planMarkdown: "from params" });
	});

	it("builds review-requested payloads from changed project names", () => {
		expect(
			buildReviewRequestedEventPayload({
				params: { changedProjects: ["component-a", 7, "component-b"] },
			}),
		).toEqual({ changedProjects: ["component-a", "component-b"] });
	});

	it("builds review-completed payloads for issue findings", () => {
		expect(
			buildReviewCompletedEventPayload({
				outcome: "issues_found",
				params: { issueCount: 2, reviewMarkdown: "fallback review" },
				turnResultMarkdown: "review from turn",
			}),
		).toEqual({
			hasIssues: true,
			issueCount: 2,
			reviewMarkdown: "review from turn",
		});
	});

	it("defaults issue-count and omits markdown when issues are reported without details", () => {
		expect(
			buildReviewCompletedEventPayload({
				outcome: "issues_found",
				params: {},
				turnResultMarkdown: null,
			}),
		).toEqual({
			hasIssues: true,
			issueCount: 1,
		});
	});

	it("builds review-completed payloads for no-issues outcomes", () => {
		expect(
			buildReviewCompletedEventPayload({
				outcome: "no_issues",
				params: { issueCount: 99 },
				turnResultMarkdown: "ignored",
			}),
		).toEqual({
			hasIssues: false,
			issueCount: 0,
		});
	});
});
