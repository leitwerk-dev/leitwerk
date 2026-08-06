import { describe, expect, it } from "vitest";
import { explicitSkillReferenceIds, referencedSkillIds } from "./skill-dependencies.js";

describe("skill dependencies", () => {
	it("finds slash commands and backticked available skill ids", () => {
		expect(
			referencedSkillIds(
				"Run /grilling with the `domain-modeling` skill, then read `CONTEXT.md`.",
				new Set(["grilling", "domain-modeling", "CONTEXT.md"]),
			),
		).toEqual(["grilling", "domain-modeling", "CONTEXT.md"]);
	});

	it("keeps explicit references for durable dependency discovery", () => {
		expect(explicitSkillReferenceIds("Run /missing. Then use the `present` skill.")).toEqual([
			"missing",
			"present",
		]);
		expect(referencedSkillIds("Run /missing.", new Set(["present"]))).toEqual([]);
	});
});
