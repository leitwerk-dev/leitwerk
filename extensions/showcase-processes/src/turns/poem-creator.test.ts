import {
	type HumanTurnDefinition,
	type LlmTurnDefinition,
	resolveHumanTurnView,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { poemCreatorProcess } from "../process-definition.js";
import {
	buildDraftPoemInstruction,
	buildReviewPoemInstruction,
	buildRevisePoemInstruction,
	poemCreatorActionIds,
} from "./poem-creator.js";

describe("poem creator turn prompts", () => {
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

	it("continues poem revisions on primary and reviews on their side branch", () => {
		const draftTurn = poemCreatorProcess.turns.get("draft_poem")?.definition as LlmTurnDefinition;
		const reviewTurn = poemCreatorProcess.turns.get("review_poem_draft")
			?.definition as LlmTurnDefinition;

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

	it("makes only the non-terminal poem review-loop actions schedulable", () => {
		const poemReviewView = resolveHumanTurnView({
			turnId: "poem_review",
			turn: poemCreatorProcess.turns.get("poem_review")?.definition as HumanTurnDefinition,
		});
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

		const reviewFeedbackView = resolveHumanTurnView({
			turnId: "poem_review_feedback",
			turn: poemCreatorProcess.turns.get("poem_review_feedback")?.definition as HumanTurnDefinition,
		});
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
