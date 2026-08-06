import { describe, expect, it } from "vitest";
import {
	defaultProcessTurnStartSelection,
	resolveExistingProcessEntryId,
	resolveProcessProductRefEntryId,
	resolveProcessSemanticRefEntryId,
	resolveProcessTurnStartSelection,
	resolveProcessTurnStartTarget,
} from "./turn-start-resolution.js";

describe("turn start resolution", () => {
	it("defaults starts from branch type", () => {
		expect(defaultProcessTurnStartSelection("primary")).toEqual({ kind: "current_leaf" });
		expect(defaultProcessTurnStartSelection("leaf_branch")).toEqual({ kind: "current_leaf" });
		expect(defaultProcessTurnStartSelection("root_branch")).toEqual({ kind: "session_root" });
	});

	it("resolves explicit start selection before branch defaults", () => {
		expect(
			resolveProcessTurnStartSelection({
				branchType: "primary",
				startFrom: { kind: "session_root" },
			}),
		).toEqual({ kind: "session_root" });
	});

	it("filters missing and stale entry ids", () => {
		expect(resolveExistingProcessEntryId(null)).toBeNull();
		expect(resolveExistingProcessEntryId("ent_1", (entryId) => entryId === "ent_1")).toBe("ent_1");
		expect(resolveExistingProcessEntryId("ent_2", (entryId) => entryId === "ent_1")).toBeNull();
	});

	it("falls semantic root/current refs back to resolved structural ids", () => {
		expect(
			resolveProcessSemanticRefEntryId({
				ref: "currentPrimaryPathLeaf",
				semanticEntryRefs: {
					plan: null,
					review: null,
					currentPrimaryPathLeaf: { entryId: "stale", turnRecordId: null },
					rootEntry: null,
				},
				currentLeafId: "leaf_1",
				rootEntryId: "root_1",
				entryExists: (entryId) => entryId !== "stale",
			}),
		).toBe("leaf_1");

		expect(
			resolveProcessSemanticRefEntryId({
				ref: "rootEntry",
				semanticEntryRefs: null,
				currentLeafId: "leaf_1",
				rootEntryId: "root_1",
			}),
		).toBe("root_1");
	});

	it("resolves product refs from process product state", () => {
		expect(
			resolveProcessProductRefEntryId({
				productName: "simplification-plan",
				productRefs: {
					"simplification-plan": { entryId: "ent_simplify", turnRecordId: "trn_1" },
				},
				entryExists: (entryId) => entryId === "ent_simplify",
			}),
		).toBe("ent_simplify");

		expect(
			resolveProcessProductRefEntryId({
				productName: "simplification-plan",
				productRefs: {
					"simplification-plan": { entryId: "missing", turnRecordId: "trn_1" },
				},
				entryExists: (entryId) => entryId !== "missing",
			}),
		).toBeNull();
	});

	it("resolves start targets and fork ids consistently", () => {
		expect(
			resolveProcessTurnStartTarget({
				branchType: "root_branch",
				selection: { kind: "session_root" },
				currentLeafId: "leaf_1",
				rootEntryId: "root_1",
			}),
		).toEqual({ forkPiEntryId: null, startTarget: { kind: "root" } });

		expect(
			resolveProcessTurnStartTarget({
				branchType: "root_branch",
				selection: { kind: "session_root" },
				currentLeafId: null,
				rootEntryId: null,
			}),
		).toEqual({ forkPiEntryId: null, startTarget: { kind: "root" } });
	});

	it("falls stale semantic refs back through explicit fallback or branch default", () => {
		expect(
			resolveProcessTurnStartTarget({
				branchType: "primary",
				selection: {
					kind: "semantic_ref",
					ref: "plan",
					fallback: { kind: "session_root" },
				},
				currentLeafId: "leaf_1",
				rootEntryId: "root_1",
				semanticEntryRefs: {
					plan: { entryId: "missing", turnRecordId: "trn_1" },
					review: null,
					currentPrimaryPathLeaf: null,
					rootEntry: null,
				},
				entryExists: (entryId) => entryId !== "missing",
			}),
		).toEqual({ forkPiEntryId: null, startTarget: { kind: "root" } });

		expect(
			resolveProcessTurnStartTarget({
				branchType: "primary",
				selection: { kind: "semantic_ref", ref: "plan" },
				currentLeafId: "leaf_1",
				rootEntryId: "root_1",
				semanticEntryRefs: null,
			}),
		).toEqual({ forkPiEntryId: "leaf_1", startTarget: { kind: "current_leaf" } });
	});

	it("falls product refs back through chained semantic refs", () => {
		expect(
			resolveProcessTurnStartTarget({
				branchType: "primary",
				selection: {
					kind: "product_ref",
					productName: "simplification-plan",
					fallback: {
						kind: "semantic_ref",
						ref: "review",
						fallback: { kind: "current_leaf" },
					},
				},
				currentLeafId: "leaf_1",
				rootEntryId: "root_1",
				semanticEntryRefs: {
					plan: null,
					review: { entryId: "review_1", turnRecordId: "trn_review" },
					currentPrimaryPathLeaf: null,
					rootEntry: null,
				},
				productRefs: {
					"simplification-plan": { entryId: "missing", turnRecordId: "trn_simplify" },
				},
				entryExists: (entryId) => entryId !== "missing",
			}),
		).toEqual({ forkPiEntryId: "review_1", startTarget: { kind: "entry", entryId: "review_1" } });
	});
});
