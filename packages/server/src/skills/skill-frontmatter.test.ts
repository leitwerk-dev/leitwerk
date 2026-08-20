import { describe, expect, it } from "vitest";
import { isSkillModelInvocable } from "./skill-frontmatter.js";

describe("skill frontmatter", () => {
	it.each([
		["# Review", true],
		["---\nname: review\n---\n# Review", true],
		["---\nname: review\ndisable-model-invocation: true\n---\n# Review", false],
		["---\ndisable-model-invocation: false\n---\n# Review", true],
		["---\ndisable-model-invocation: 'true'\n---\n# Review", true],
	] as const)("matches Pi's model invocation semantics for %j", (markdown, expected) => {
		expect(isSkillModelInvocable(markdown)).toBe(expected);
	});
});
