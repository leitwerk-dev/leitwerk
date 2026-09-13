import { expect, it } from "vitest";
import { readFiniteNumber } from "./number-normalize.js";

it.each([
	[0, 0],
	[-0, -0],
	[-2.5, -2.5],
	[" 2.5 ", 2.5],
	["1e2", 100],
	["0x10", 16],
	["", null],
	[" \t\n", null],
	["invalid", null],
	["Infinity", null],
	["1e999", null],
	[Number.POSITIVE_INFINITY, null],
	[Number.NaN, null],
	[null, null],
	[undefined, null],
	[true, null],
	[[], null],
	[{}, null],
])("reads finite numeric input %j", (value, expected) => {
	expect(readFiniteNumber(value)).toBe(expected);
});
