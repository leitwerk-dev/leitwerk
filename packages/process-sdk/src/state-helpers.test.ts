import { describe, expect, it } from "vitest";
import { createEmptyStructuralProcessState, structuralStateCodec } from "./state-helpers.js";

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
			structuralStateCodec.parse({
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

	it("serializes state unchanged", () => {
		const state = createEmptyStructuralProcessState();
		expect(structuralStateCodec.serialize(state)).toBe(state);
	});
});
