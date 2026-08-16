import { describe, expect, it } from "vitest";
import { isSkillModelInvocable } from "./skill-frontmatter.js";

describe("skill frontmatter", () => {
	it("allows model invocation by default", () => {
		expect(isSkillModelInvocable("# Review")).toBe(true);
		expect(isSkillModelInvocable("---\nname: review\n---\n# Review")).toBe(true);
	});

	it("recognizes skills that disable model invocation", () => {
		expect(
			isSkillModelInvocable("---\nname: review\ndisable-model-invocation: true\n---\n# Review"),
		).toBe(false);
	});

	it("matches Pi's strict boolean frontmatter semantics", () => {
		expect(isSkillModelInvocable("---\ndisable-model-invocation: false\n---\n# Review")).toBe(true);
		expect(isSkillModelInvocable("---\ndisable-model-invocation: 'true'\n---\n# Review")).toBe(
			true,
		);
	});
});
