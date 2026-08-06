import { describe, expect, it } from "vitest";
import {
	createEmptyProcessSemanticEntryRefs,
	isProcessSemanticEntryRefKey,
	PROCESS_SEMANTIC_ENTRY_REF_KEYS,
	parseProcessSemanticEntryRefs,
	parseSemanticEntryRef,
} from "./semantic-entry-refs.js";

describe("parseSemanticEntryRef", () => {
	it("returns null when entryId is missing", () => {
		expect(parseSemanticEntryRef({ turnRecordId: "trn_1" })).toBeNull();
	});

	it("returns null when entryId is empty", () => {
		expect(parseSemanticEntryRef({ entryId: "   ", turnRecordId: "trn_1" })).toBeNull();
	});

	it("normalizes null or missing turnRecordId to null", () => {
		expect(parseSemanticEntryRef({ entryId: "  ent_1  " })).toEqual({
			entryId: "ent_1",
			turnRecordId: null,
		});
		expect(parseSemanticEntryRef({ entryId: "ent_1", turnRecordId: null })).toEqual({
			entryId: "ent_1",
			turnRecordId: null,
		});
	});

	it.each([
		null,
		undefined,
		true,
		1,
		"entry",
		[],
	])("returns null for non-object input %j", (value) => {
		expect(parseSemanticEntryRef(value)).toBeNull();
	});
});

describe("parseProcessSemanticEntryRefs", () => {
	it("parses partial objects and defaults omitted refs to null", () => {
		expect(
			parseProcessSemanticEntryRefs({
				plan: { entryId: "  ent_plan  ", turnRecordId: " trn_plan " },
			}),
		).toEqual({
			...createEmptyProcessSemanticEntryRefs(),
			plan: { entryId: "ent_plan", turnRecordId: "trn_plan" },
		});
	});

	it.each([
		null,
		undefined,
		true,
		"refs",
		[],
	])("falls back to the empty shape for non-object input %j", (value) => {
		expect(parseProcessSemanticEntryRefs(value)).toEqual(createEmptyProcessSemanticEntryRefs());
	});

	it("returns the all-null default shape when no refs are present", () => {
		expect(parseProcessSemanticEntryRefs({})).toEqual(createEmptyProcessSemanticEntryRefs());
	});
});

describe("isProcessSemanticEntryRefKey", () => {
	it("recognizes supported semantic entry ref keys", () => {
		for (const value of PROCESS_SEMANTIC_ENTRY_REF_KEYS) {
			expect(isProcessSemanticEntryRefKey(value)).toBe(true);
		}
		expect(isProcessSemanticEntryRefKey("notARef")).toBe(false);
	});
});

describe("createEmptyProcessSemanticEntryRefs", () => {
	it("initializes every semantic ref slot to null", () => {
		expect(createEmptyProcessSemanticEntryRefs()).toEqual({
			plan: null,
			review: null,
			currentPrimaryPathLeaf: null,
			rootEntry: null,
		});
	});
});
