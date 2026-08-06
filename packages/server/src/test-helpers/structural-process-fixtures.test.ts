import { createReviewSubject } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	createStructuralProcessState,
	createStructuralStateJson,
	structuralProcessStateCodec,
} from "./structural-process-fixtures.js";

describe("structural-process-fixtures", () => {
	it("merges semantic entry ref overrides onto the empty structural state", () => {
		const state = createStructuralProcessState({
			reviewSubject: createReviewSubject("plan"),
			semanticEntryRefs: {
				rootEntry: { entryId: "root-user", turnRecordId: null },
				plan: { entryId: "assistant-plan", turnRecordId: "trn_plan_1" },
			},
		});

		expect(state.reviewSubject).toEqual({ kind: "plan" });
		expect(state.semanticEntryRefs.rootEntry).toEqual({
			entryId: "root-user",
			turnRecordId: null,
		});
		expect(state.semanticEntryRefs.plan).toEqual({
			entryId: "assistant-plan",
			turnRecordId: "trn_plan_1",
		});
		expect(state.semanticEntryRefs.currentPrimaryPathLeaf).toBeNull();
		expect(state.semanticEntryRefs.review).toBeNull();
	});

	it("serializes structural state overrides to JSON without dropping defaults", () => {
		const stateJson = createStructuralStateJson({
			semanticEntryRefs: {
				currentPrimaryPathLeaf: { entryId: "assistant-impl", turnRecordId: "trn_impl_1" },
			},
		});

		expect(JSON.parse(stateJson)).toEqual({
			reviewSubject: null,
			productRefs: {},
			semanticEntryRefs: {
				rootEntry: null,
				currentPrimaryPathLeaf: { entryId: "assistant-impl", turnRecordId: "trn_impl_1" },
				plan: null,
				review: null,
			},
		});
	});

	it("parses structural process state through the shared codec", () => {
		const state = structuralProcessStateCodec.parse({
			reviewSubject: { kind: "implementation" },
			semanticEntryRefs: {
				review: { entryId: "review-entry", turnRecordId: "trn_review_1" },
			},
		});

		expect(state.reviewSubject).toEqual({ kind: "implementation" });
		expect(state.semanticEntryRefs.review).toEqual({
			entryId: "review-entry",
			turnRecordId: "trn_review_1",
		});
		expect(state.semanticEntryRefs.rootEntry).toBeNull();
	});
});
