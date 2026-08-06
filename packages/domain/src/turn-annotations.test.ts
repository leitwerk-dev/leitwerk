import { describe, expect, it } from "vitest";
import { parseTurnAnnotationReference, parseTurnAnnotationReferences } from "./turn-annotations.js";

describe("parseTurnAnnotationReference", () => {
	it("parses turn-record references", () => {
		expect(
			parseTurnAnnotationReference({
				kind: "turn_record",
				turnRecordId: "  trn_1  ",
				role: " subject ",
			}),
		).toEqual({
			kind: "turn_record",
			turnRecordId: "trn_1",
			role: "subject",
		});
	});

	it("parses entry references", () => {
		expect(parseTurnAnnotationReference({ kind: "entry", entryId: " ent_1 ", role: null })).toEqual(
			{
				kind: "entry",
				entryId: "ent_1",
				role: null,
			},
		);
	});

	it("parses semantic-entry-ref references", () => {
		expect(
			parseTurnAnnotationReference({
				kind: "semantic_entry_ref",
				ref: " review ",
			}),
		).toEqual({
			kind: "semantic_entry_ref",
			ref: "review",
			role: null,
		});
	});

	it.each([
		null,
		undefined,
		true,
		1,
		"ref",
		[],
		{},
		{ kind: "turn_record" },
		{ kind: "entry", entryId: "   " },
		{ kind: "semantic_entry_ref", ref: "unknownRef" },
		{ kind: "unknown", id: "x" },
	])("returns null for invalid input %j", (value) => {
		expect(parseTurnAnnotationReference(value)).toBeNull();
	});
});

describe("parseTurnAnnotationReferences", () => {
	it("parses arrays and drops invalid references", () => {
		expect(
			parseTurnAnnotationReferences([
				{ kind: "turn_record", turnRecordId: "trn_1" },
				{ kind: "entry", entryId: "ent_1", role: "source" },
				{ kind: "semantic_entry_ref", ref: "review" },
				{ kind: "entry", entryId: "   " },
			]),
		).toEqual([
			{ kind: "turn_record", turnRecordId: "trn_1", role: null },
			{ kind: "entry", entryId: "ent_1", role: "source" },
			{ kind: "semantic_entry_ref", ref: "review", role: null },
		]);
	});

	it.each([
		null,
		undefined,
		true,
		"refs",
		{},
	])("returns an empty list for non-array input %j", (value) => {
		expect(parseTurnAnnotationReferences(value)).toEqual([]);
	});
});
