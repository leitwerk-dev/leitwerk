import { describe, expect, it } from "vitest";
import {
	buildPoemLeafOutcomeFallbackMarkdown,
	buildPoemLeafOutcomePayload,
	extractLeafEntryMarkdown,
	parsePoemLeafMarkdown,
	resolvePoemLeafMarkdown,
} from "./poem-leaf-outcome.js";

describe("poem leaf outcome helpers", () => {
	it("parses a heading-based poem into title and stanzas", () => {
		const parsed = parsePoemLeafMarkdown(
			`# Berlin at Dusk\n\nTin rooftops glow<br>Quiet trams return\n\nRelease trains hum<br>Night windows burn`,
		);
		expect(parsed).toEqual({
			title: "Berlin at Dusk",
			stanzas: [
				["Tin rooftops glow", "Quiet trams return"],
				["Release trains hum", "Night windows burn"],
			],
		});
	});

	it("prefers persisted turnResultMarkdown and falls back to the selected leaf entry content", () => {
		expect(
			resolvePoemLeafMarkdown({
				turnResultMarkdown: "# Final\n\nPrimary path wins",
				leafEntry: {
					id: "assistant-1",
					parentId: "user-1",
					type: "assistant",
					timestamp: "2026-04-18T10:00:00.000Z",
					message: { role: "assistant", content: "# Leaf\n\nFallback" },
				},
			}),
		).toBe("# Final\n\nPrimary path wins");
		expect(
			resolvePoemLeafMarkdown({
				turnResultMarkdown: null,
				leafEntry: {
					id: "assistant-2",
					parentId: "user-1",
					type: "assistant",
					timestamp: "2026-04-18T10:01:00.000Z",
					message: { role: "assistant", content: "# Leaf\n\nFallback" },
				},
			}),
		).toBe("# Leaf\n\nFallback");
		expect(extractLeafEntryMarkdown(null)).toBeNull();
	});

	it("builds structured poem payloads for the browser renderer", () => {
		const payload = buildPoemLeafOutcomePayload({
			prompt: "Write a short poem about shipping cloud software at dusk.",
			markdown: `# Cloud Dusk\n\nAmber deploys bloom<br>Across the evening graph`,
		});
		expect(payload).toEqual({
			prompt: "Write a short poem about shipping cloud software at dusk.",
			markdown: `# Cloud Dusk\n\nAmber deploys bloom<br>Across the evening graph`,
			title: "Cloud Dusk",
			stanzas: [["Amber deploys bloom", "Across the evening graph"]],
		});
	});

	it("adds optional review data to structured review-leaf payloads", () => {
		const payload = buildPoemLeafOutcomePayload({
			prompt: "Write a short poem about release trains at dusk.",
			markdown: `# Platform Glow\n\nSignals gather<br>Over evening tracks`,
			review: {
				outcome: "leave_feedback",
				summary: "The ending loses energy.",
				feedback: "Sharpen the final image and land on a warmer closing note.",
			},
		});
		expect(payload).toEqual({
			prompt: "Write a short poem about release trains at dusk.",
			markdown: `# Platform Glow\n\nSignals gather<br>Over evening tracks`,
			title: "Platform Glow",
			stanzas: [["Signals gather", "Over evening tracks"]],
			review: {
				outcome: "leave_feedback",
				summary: "The ending loses energy.",
				feedback: "Sharpen the final image and land on a warmer closing note.",
			},
		});
	});

	it("builds fallback markdown for review findings and no-issues opinions", () => {
		expect(
			buildPoemLeafOutcomeFallbackMarkdown({
				markdown: `# Platform Glow\n\nSignals gather<br>Over evening tracks`,
				review: {
					outcome: "leave_feedback",
					summary: "The ending loses energy.",
					feedback: "Sharpen the final image and land on a warmer closing note.",
				},
			}),
		).toBe(
			`# Platform Glow\n\nSignals gather<br>Over evening tracks\n\n## Review\n\nThe ending loses energy.\n\nSharpen the final image and land on a warmer closing note.`,
		);
		expect(
			buildPoemLeafOutcomeFallbackMarkdown({
				markdown: `# Platform Glow\n\nSignals gather<br>Over evening tracks`,
				review: {
					outcome: "no_issues",
					summary: "The revised poem is ready to publish.",
				},
			}),
		).toBe(
			`# Platform Glow\n\nSignals gather<br>Over evening tracks\n\n## LLM Opinion\n\nThe revised poem is ready to publish.`,
		);
	});
});
