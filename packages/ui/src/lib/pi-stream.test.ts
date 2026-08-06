import { describe, expect, it } from "vitest";
import { hasDisplayableText } from "./pi-stream.js";

describe("pi-stream helpers", () => {
	it("checks whether text has displayable content", () => {
		expect(hasDisplayableText("Ready")).toBe(true);
		expect(hasDisplayableText("   \n")).toBe(false);
	});
});
