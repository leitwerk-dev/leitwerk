import { describe, expect, it } from "vitest";
import { createEmptyStructuralProcessState, parseStructuralProcessState } from "./state-helpers.js";

describe("state helpers", () => {
	it("creates the empty structural state with null reviewSubject", () => {
		expect(createEmptyStructuralProcessState()).toMatchObject({
			reviewSubject: null,
			productRefs: {},
			semanticEntryRefs: {
				plan: null,
				review: null,
				currentPrimaryPathLeaf: null,
				rootEntry: null,
			},
		});
	});

	it("parses reviewSubject from structural process state", () => {
		expect(
			parseStructuralProcessState({
				reviewSubject: { kind: "implementation" },
				semanticEntryRefs: {
					plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
				},
			}),
		).toEqual({
			semanticEntryRefs: {
				plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
				review: null,
				currentPrimaryPathLeaf: null,
				rootEntry: null,
			},
			productRefs: {},
			reviewSubject: { kind: "implementation" },
		});
	});

	it("falls back to null reviewSubject for missing or invalid values", () => {
		expect(parseStructuralProcessState({})).toMatchObject({ reviewSubject: null });
		expect(
			parseStructuralProcessState({
				reviewSubject: { kind: "review_result" },
			}),
		).toMatchObject({ reviewSubject: null });
	});
});
