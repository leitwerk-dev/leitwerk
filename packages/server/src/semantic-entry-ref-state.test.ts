import { describe, expect, it } from "vitest";
import {
	deriveInputConsumedSemanticEntryRefPatch,
	deriveTurnOutcomeSemanticEntryRefPatch,
	mergeSemanticEntryRefPatchIntoStateJson,
} from "./semantic-entry-ref-state.js";

describe("semantic-entry-ref-state", () => {
	it("merges semantic entry refs into stateJson without dropping other state fields", () => {
		const nextStateJson = mergeSemanticEntryRefPatchIntoStateJson(
			JSON.stringify({
				readyForHumanReview: true,
			}),
			{
				plan: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
				currentPrimaryPathLeaf: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
				rootEntry: { entryId: "user-1", turnRecordId: null },
			},
		);
		expect(nextStateJson).not.toBeNull();
		expect(JSON.parse(nextStateJson ?? "null")).toEqual({
			readyForHumanReview: true,
			semanticEntryRefs: {
				plan: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
				review: null,
				currentPrimaryPathLeaf: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
				rootEntry: { entryId: "user-1", turnRecordId: null },
			},
		});
	});

	it("preserves existing semantic entry refs when the next stateJson omits them", () => {
		const nextStateJson = mergeSemanticEntryRefPatchIntoStateJson(
			JSON.stringify({ readyForHumanReview: false }),
			{
				review: { entryId: "turn-2", turnRecordId: "trn_review_1" },
			},
			{
				fallbackStateJson: JSON.stringify({
					semanticEntryRefs: {
						currentPrimaryPathLeaf: { entryId: "turn-1", turnRecordId: "trn_impl_1" },
					},
				}),
			},
		);
		expect(JSON.parse(nextStateJson ?? "null")).toMatchObject({
			readyForHumanReview: false,
			semanticEntryRefs: {
				review: { entryId: "turn-2", turnRecordId: "trn_review_1" },
				currentPrimaryPathLeaf: { entryId: "turn-1", turnRecordId: "trn_impl_1" },
			},
		});
	});

	it("returns null when the semantic entry ref patch does not change stateJson", () => {
		const stateJson = JSON.stringify({
			semanticEntryRefs: {
				plan: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
				review: null,
				currentPrimaryPathLeaf: null,
				rootEntry: null,
			},
		});
		expect(
			mergeSemanticEntryRefPatchIntoStateJson(stateJson, {
				plan: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
			}),
		).toBeNull();
	});

	it("derives plan and currentPrimaryPathLeaf updates from plan-producing turn outcomes", () => {
		expect(
			deriveTurnOutcomeSemanticEntryRefPatch({
				turnRecordId: "trn_plan_1",
				resultSemanticRef: "plan",
				pathType: "primary",
				resultPiEntryId: "turn-1",
				rootEntryId: "user-1",
			}),
		).toEqual({
			plan: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
			currentPrimaryPathLeaf: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
			rootEntry: { entryId: "user-1", turnRecordId: null },
		});
	});

	it("derives review updates from review turn outcomes without moving currentPrimaryPathLeaf", () => {
		expect(
			deriveTurnOutcomeSemanticEntryRefPatch({
				turnRecordId: "trn_review_1",
				resultSemanticRef: "review",
				pathType: "root_branch",
				resultPiEntryId: "turn-2",
				rootEntryId: "user-1",
			}),
		).toEqual({
			review: { entryId: "turn-2", turnRecordId: "trn_review_1" },
			rootEntry: { entryId: "user-1", turnRecordId: null },
		});
	});

	it("derives targeted input acknowledgements without overwriting the primary path for review-branch prompts", () => {
		expect(
			deriveInputConsumedSemanticEntryRefPatch({
				rootEntryId: "user-1",
				targetSemanticRef: "review",
				targetEntryId: "user-3",
			}),
		).toEqual({
			review: { entryId: "user-3", turnRecordId: null },
			rootEntry: { entryId: "user-1", turnRecordId: null },
		});
	});

	it("derives targeted currentPrimaryPathLeaf acknowledgements for primary-branch follow-up prompts", () => {
		expect(
			deriveInputConsumedSemanticEntryRefPatch({
				currentPrimaryPathLeafId: "user-4",
				rootEntryId: "user-1",
				targetSemanticRef: "currentPrimaryPathLeaf",
				targetEntryId: "user-4",
			}),
		).toEqual({
			currentPrimaryPathLeaf: { entryId: "user-4", turnRecordId: null },
			rootEntry: { entryId: "user-1", turnRecordId: null },
		});
	});
});
