import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { describe, expect, it } from "vitest";
import { poemCreatorProcess } from "../process-definition.js";
import {
	buildDraftPoemInstruction,
	buildReviewPoemInstruction,
	buildRevisePoemInstruction,
	poemCreatorActionIds,
} from "./poem-creator.js";

describe("poem creator turn prompts", () => {
	it("defines the poem review turn with no_issues and leave_feedback only", () => {
		const turn = poemCreatorProcess.turns.get("review_poem_draft")?.definition;
		expect(turn?.kind).toBe("llm");
		if (turn?.kind !== "llm") {
			throw new Error("expected review_poem_draft to be an LLM turn");
		}
		expect(Object.keys(turn.outcomes ?? {}).sort()).toEqual(["leave_feedback", "no_issues"]);
		expect(turn.resultSemanticRef).toBe("review");
		expect(turn.turnResultMarkdown).toBeUndefined();
		expect(turn.outcomes?.no_issues).toMatchObject({
			publishedProduct: "review",
			turnResultMarkdownParameter: "review",
		});
		expect(turn.outcomes?.leave_feedback).toMatchObject({
			publishedProduct: "message",
			turnResultMarkdownParameter: "message",
		});
	});

	it("includes the requested poem subject", () => {
		const prompt = buildDraftPoemInstruction("SENTINEL_POEM_SUBJECT");

		expect(prompt).toContain("SENTINEL_POEM_SUBJECT");
	});

	it("includes the review request and poem draft", () => {
		const prompt = buildReviewPoemInstruction(
			"SENTINEL_POEM_REVIEW_REQUEST",
			"SENTINEL_POEM_DRAFT",
		);

		expect(prompt).toContain("SENTINEL_POEM_REVIEW_REQUEST");
		expect(prompt).toContain("SENTINEL_POEM_DRAFT");
	});

	it("builds a focused revision prompt for the inherited poem branch", () => {
		const prompt = buildRevisePoemInstruction("SENTINEL_REVISION_GUIDANCE");

		expect(prompt).toContain("SENTINEL_REVISION_GUIDANCE");
		expect(prompt).toContain("current poem on this branch");
		expect(prompt).toContain("Preserve the parts");
	});

	it("continues poem revisions on primary and reviews on their side branch", async ({
		onTestFinished,
	}) => {
		const test = await createExtensionTestHarness();
		onTestFinished(() => test.close());
		const turns = test.process(poemCreatorProcess, { params: { prompt: "Test" } }).describe().turns;
		const draftTurn = turns.find((t) => t.id === "draft_poem");
		const reviewTurn = turns.find((t) => t.id === "review_poem_draft");

		expect(draftTurn).toMatchObject({
			branchType: "primary",
			context: "full",
			startFrom: {
				kind: "semantic_ref",
				ref: "currentPrimaryPathLeaf",
				fallback: { kind: "current_leaf" },
			},
		});
		expect(reviewTurn).toMatchObject({
			branchType: "root_branch",
			context: "full",
			restorePrimaryLeafAfterTurn: true,
			startFrom: {
				kind: "semantic_ref",
				ref: "review",
				fallback: { kind: "current_leaf" },
			},
		});
	});

	it("makes only the non-terminal poem review-loop actions schedulable", async ({
		onTestFinished,
	}) => {
		const test = await createExtensionTestHarness();
		onTestFinished(() => test.close());
		const turns = test.process(poemCreatorProcess, { params: { prompt: "Test" } }).describe().turns;
		const poemReviewView = turns.find((t) => t.id === "poem_review")?.humanView;
		if (!poemReviewView) throw new Error("Missing poem review description");
		const poemReviewActions = new Map(
			poemReviewView.actions.map((action) => [action.actionId, action]),
		);
		expect(poemReviewActions.get(poemCreatorActionIds.completePoem)?.scheduling).toBeUndefined();
		expect(poemReviewActions.get(poemCreatorActionIds.requestRevision)?.scheduling).toMatchObject({
			preview: { kind: "trigger", trigger: "revision_requested" },
		});
		expect(poemReviewActions.get(poemCreatorActionIds.runAutoReview)?.scheduling).toMatchObject({
			preview: { kind: "trigger", trigger: "operator_re_review" },
		});

		const reviewFeedbackView = turns.find((t) => t.id === "poem_review_feedback")?.humanView;
		if (!reviewFeedbackView) throw new Error("Missing review feedback description");
		const reviewFeedbackActions = new Map(
			reviewFeedbackView.actions.map((action) => [action.actionId, action]),
		);
		expect(
			reviewFeedbackActions.get(poemCreatorActionIds.requestReviewChanges)?.scheduling,
		).toMatchObject({
			preview: { kind: "trigger", trigger: "operator_re_review" },
		});
		expect(reviewFeedbackActions.get(poemCreatorActionIds.dismissReview)).toMatchObject({
			acceptanceState: "neutral",
			label: "Dismiss review",
		});
		expect(
			reviewFeedbackActions.get(poemCreatorActionIds.dismissReview)?.scheduling,
		).toBeUndefined();
	});
});
