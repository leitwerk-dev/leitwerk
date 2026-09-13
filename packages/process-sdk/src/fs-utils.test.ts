import { expect, it } from "vitest";
import { hasErrorCode, isEnoent, isPathInside } from "./fs-utils.js";

it("matches requested error codes on objects without requiring Error inheritance", () => {
	for (const error of [
		{ code: "EEXIST" },
		Object.assign(new Error("exists"), { code: "EEXIST" }),
		Object.assign([], { code: "EEXIST" }),
		Object.create({ code: "EEXIST" }),
	]) {
		expect(hasErrorCode(error, "EEXIST")).toBe(true);
		expect(isEnoent(error)).toBe(false);
	}
	expect(isEnoent({ code: "ENOENT" })).toBe(true);
});

it.each([
	null,
	undefined,
	"ENOENT",
	1,
	{},
	{ code: 1 },
])("rejects absent or nonmatching error codes in %j", (error) => {
	expect(hasErrorCode(error, "ENOENT")).toBe(false);
});

it.each([
	["/workspace/component", true],
	["/workspace/a/../b", true],
	["/workspace", false],
	["/", false],
	["/workspace-other/component", false],
	["/workspace/../escape", false],
])("checks strict lexical descendants: %s", (child, expected) => {
	expect(isPathInside("/workspace", child)).toBe(expected);
});
