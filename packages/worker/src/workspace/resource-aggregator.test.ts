import { describe, expect, it } from "vitest";
import { aggregateAgentsMd, collectSkills, formatProvenanceMarker } from "./resource-aggregator.js";

describe("formatProvenanceMarker", () => {
	it("uses forward slashes in marker", () => {
		expect(formatProvenanceMarker("svc/a", "AGENTS.md")).toBe("<!-- source: svc/a/AGENTS.md -->");
	});
});

describe("aggregateAgentsMd", () => {
	it("orders by componentKey and adds provenance", () => {
		const out = aggregateAgentsMd([
			{ componentKey: "b", filePath: "AGENTS.md", content: "two" },
			{ componentKey: "a", filePath: "AGENTS.md", content: "one" },
		]);
		expect(out).toBe(
			[
				"<!-- source: a/AGENTS.md -->",
				"",
				"one",
				"",
				"<!-- source: b/AGENTS.md -->",
				"",
				"two",
				"",
			].join("\n"),
		);
	});

	it("returns empty string when no sources", () => {
		expect(aggregateAgentsMd([])).toBe("");
	});
});

describe("collectSkills", () => {
	it("dedupes by skillId with lexicographically first componentKey winning", () => {
		const m = collectSkills([
			{ componentKey: "b", skillId: "s1", content: "from-b" },
			{ componentKey: "a", skillId: "s1", content: "from-a" },
			{ componentKey: "a", skillId: "s1", content: "later-from-a" },
			{ componentKey: "c", skillId: "s1", content: "from-c" },
		]);
		expect(m.get("s1")).toEqual({ content: "from-a", source: "a" });
	});

	it("keeps skill ids in first-seen order when replacing a winner", () => {
		const m = collectSkills([
			{ componentKey: "c", skillId: "s2", content: "old" },
			{ componentKey: "b", skillId: "s1", content: "1" },
			{ componentKey: "a", skillId: "s2", content: "new" },
		]);
		expect([...m]).toEqual([
			["s2", { content: "new", source: "a" }],
			["s1", { content: "1", source: "b" }],
		]);
	});
});
