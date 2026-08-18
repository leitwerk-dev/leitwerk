import { describe, expect, it } from "vitest";
import { createEmptyStructuralProcessState, parseStructuralProcessState } from "./state-helpers.js";

describe("structural process state", () => {
	it("creates empty semantic and product refs", () => {
		expect(createEmptyStructuralProcessState()).toEqual({
			semanticEntryRefs: {
				plan: null,
				review: null,
				currentPrimaryPathLeaf: null,
				rootEntry: null,
			},
			productRefs: {},
		});
	});

	it("parses semantic and product refs", () => {
		expect(
			parseStructuralProcessState({
				semanticEntryRefs: {
					plan: { entryId: "plan-entry", turnRecordId: "plan-turn" },
				},
				productRefs: {
					plan: { entryId: "plan-entry", turnRecordId: "plan-turn" },
				},
			}),
		).toMatchObject({
			semanticEntryRefs: {
				plan: { entryId: "plan-entry", turnRecordId: "plan-turn" },
			},
			productRefs: {
				plan: { entryId: "plan-entry", turnRecordId: "plan-turn" },
			},
		});
	});
});
