import { describe, expect, it } from "vitest";
import { parseSkillPackManifest } from "./skill-pack.js";

function pack() {
	return {
		formatVersion: 1,
		upstream: { url: "https://example.test/skills", commit: "a".repeat(40) },
		patchDigest: "b".repeat(64),
		skills: [
			{
				id: "review",
				directory: "review",
				label: "Review",
				description: "Review code",
				sourcePath: "skills/review",
				dependencies: ["design"],
			},
			{
				id: "design",
				directory: "design",
				label: "Design",
				description: "Design code",
				sourcePath: "skills/design",
				dependencies: [] as string[],
			},
		],
	};
}

describe("skill pack contract", () => {
	it("rejects dependency cycles, missing members, and duplicate IDs", () => {
		const valid = pack();
		expect(parseSkillPackManifest(valid).skills).toHaveLength(2);
		const cycle = pack();
		cycle.skills[1].dependencies = ["review"];
		expect(() => parseSkillPackManifest(cycle)).toThrow("Circular skill dependency");
		const missing = pack();
		missing.skills.pop();
		expect(() => parseSkillPackManifest(missing)).toThrow("Missing skill pack dependency");
		const repeated = pack();
		repeated.skills[0].dependencies = ["design", "design"];
		expect(() => parseSkillPackManifest(repeated)).toThrow(
			"Duplicate dependencies for skill 'review'",
		);
		const duplicate = pack();
		duplicate.skills.push(duplicate.skills[0]);
		expect(() => parseSkillPackManifest(duplicate)).toThrow("Duplicate skill ID");
	});
	it.each([
		"../outside",
		"/tmp/outside",
		"a/../../outside",
		"a\\outside",
		"a/.git/b",
	])("rejects unsafe resource directory %s", (directory) => {
		const manifest = pack();
		manifest.skills[0].directory = directory;
		expect(() => parseSkillPackManifest(manifest)).toThrow();
	});
});
