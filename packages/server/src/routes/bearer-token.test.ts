import { describe, expect, it } from "vitest";
import { parseBearerToken } from "./bearer-token.js";

describe("parseBearerToken", () => {
	it("parses Bearer credentials case-insensitively", () => {
		expect(parseBearerToken("bearer secret-token")).toBe("secret-token");
		expect(parseBearerToken("BEARER   secret-token  ")).toBe("secret-token");
	});

	it("rejects missing and non-Bearer credentials", () => {
		expect(parseBearerToken(undefined)).toBeNull();
		expect(parseBearerToken("Basic secret-token")).toBeNull();
		expect(parseBearerToken("Bearer ")).toBeNull();
	});
});
