import { describe, expect, it } from "vitest";
import { buildAutoWorkBranchFromSeed } from "./auto-work-branch.js";

describe("buildAutoWorkBranchFromSeed", () => {
	it("builds a stable Git-safe shape from the prompt and repository seed", () => {
		expect(buildAutoWorkBranchFromSeed("Fix naïve user's login flow", "repo:main", "abc")).toBe(
			"fix-naive-users-login-flow-abc-8c2076674eaf",
		);
	});

	it("uses a fallback slug and validates the random suffix", () => {
		expect(buildAutoWorkBranchFromSeed("!!!", "repo:main", "123")).toMatch(
			/^change-123-[0-9a-f]{12}$/,
		);
		expect(() => buildAutoWorkBranchFromSeed("change", "repo:main", "xyz")).toThrow(
			"Expected 3 random hex characters",
		);
	});
});
