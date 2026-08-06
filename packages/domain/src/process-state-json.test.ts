import { describe, expect, it } from "vitest";
import {
	parseProcessStateJsonLenient,
	parseProcessStateJsonStrict,
	parseProductRefsLenient,
	parseProductRefsStrict,
	parseSemanticEntryRefsFromStateJsonLenient,
	parseSemanticEntryRefsFromStateJsonStrict,
	parseSemanticEntryRefsLenient,
	parseSemanticEntryRefsStrict,
} from "./process-state-json.js";

const emptyRefs = {
	plan: null,
	review: null,
	currentPrimaryPathLeaf: null,
	rootEntry: null,
};

describe("process state JSON parsing", () => {
	it("strictly parses stateJson objects", () => {
		expect(parseProcessStateJsonStrict('{"ok":true}')).toEqual({ ok: true });
		expect(parseProcessStateJsonStrict(null)).toEqual({});
		expect(() => parseProcessStateJsonStrict("[")).toThrow(/Malformed stateJson/);
		expect(() => parseProcessStateJsonStrict("[]")).toThrow(/expected a JSON object/);
	});

	it("leniently returns an empty state for malformed or non-object stateJson", () => {
		expect(parseProcessStateJsonLenient("[")).toEqual({});
		expect(parseProcessStateJsonLenient("[]")).toEqual({});
	});

	it("strictly parses semantic entry refs", () => {
		expect(
			parseSemanticEntryRefsStrict({
				currentPrimaryPathLeaf: { entryId: "leaf", turnRecordId: "turn" },
			}),
		).toEqual({
			...emptyRefs,
			currentPrimaryPathLeaf: { entryId: "leaf", turnRecordId: "turn" },
		});
		expect(parseSemanticEntryRefsStrict(undefined)).toEqual(emptyRefs);
		expect(() => parseSemanticEntryRefsStrict("bad")).toThrow(/Malformed semanticEntryRefs/);
	});

	it("leniently returns empty refs for malformed semanticEntryRefs", () => {
		expect(parseSemanticEntryRefsLenient("bad")).toEqual(emptyRefs);
	});

	it("strictly parses product refs", () => {
		expect(
			parseProductRefsStrict({
				"implementation-summary": { entryId: "ent_impl", turnRecordId: "trn_impl" },
			}),
		).toEqual({
			"implementation-summary": { entryId: "ent_impl", turnRecordId: "trn_impl" },
		});
		expect(parseProductRefsStrict(undefined)).toEqual({});
		expect(() => parseProductRefsStrict("bad")).toThrow(/Malformed productRefs/);
		expect(() => parseProductRefsStrict({ "Bad Product": { entryId: "ent" } })).toThrow(
			/invalid product name/,
		);
		expect(() => parseProductRefsStrict({ plan: { entryId: "" } })).toThrow(
			/product 'plan' must reference an entry/,
		);
	});

	it("leniently returns empty product refs for malformed productRefs", () => {
		expect(parseProductRefsLenient("bad")).toEqual({});
		expect(parseProductRefsLenient({ "Bad Product": { entryId: "ent" } })).toEqual({});
	});

	it("parses semantic entry refs directly from stateJson with strict or lenient semantics", () => {
		const stateJson = JSON.stringify({
			semanticEntryRefs: { rootEntry: { entryId: "root", turnRecordId: null } },
		});
		expect(parseSemanticEntryRefsFromStateJsonStrict(stateJson).rootEntry).toEqual({
			entryId: "root",
			turnRecordId: null,
		});
		expect(() => parseSemanticEntryRefsFromStateJsonStrict("{")).toThrow(/Malformed stateJson/);
		expect(parseSemanticEntryRefsFromStateJsonLenient("{")).toEqual(emptyRefs);
	});
});
