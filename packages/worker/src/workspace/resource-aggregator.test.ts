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
		]);
		expect(m.get("s1")).toEqual({ content: "from-a", source: "a" });
	});

	it("keeps distinct skill ids", () => {
		const m = collectSkills([
			{ componentKey: "a", skillId: "s1", content: "1" },
			{ componentKey: "a", skillId: "s2", content: "2" },
		]);
		expect([...m.keys()].sort()).toEqual(["s1", "s2"]);
	});
});
