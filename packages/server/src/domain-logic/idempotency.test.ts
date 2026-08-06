import { describe, expect, it } from "vitest";
import { createWriteIdentity } from "./idempotency.js";

describe("idempotency", () => {
	describe("createWriteIdentity", () => {
		it("returns the provided writeType and dedupKey", () => {
			expect(createWriteIdentity("type.alpha", "alpha:1")).toEqual({
				writeType: "type.alpha",
				dedupKey: "alpha:1",
			});
		});
	});
});
