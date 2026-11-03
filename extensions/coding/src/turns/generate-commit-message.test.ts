import { describe, expect, it } from "vitest";
import {
	buildRepositoryCommitMessagesPrompt,
	normalizeGeneratedCommitMessage,
	parseRepositoryCommitMessages,
} from "./generate-commit-message.js";

describe("commit-message generation", () => {
	it("separates the accepted plan from launch-pinned repository rules", () => {
		const prompt = buildRepositoryCommitMessagesPrompt({
			process: {} as never,
			projects: [
				{
					key: "repo",
					metadata: {
						"leitwerk.commitMessage": { templateId: "conventional", rules: "Use type(scope)." },
					},
				} as never,
			],
			params: {},
			state: {},
			prompts: { initial: "" },
			input: {
				plan: "## Plan\n\nShip the durable behavior.",
				"implementation-summary": "Implemented the behavior and its compatibility adjustment.",
			},
			prepared: {
				repositories: [
					{
						key: "repo",
						path: "/workspace/repo",
						head: "baseline",
						status: { text: " M feature.ts\n", truncated: false },
						stagedDiff: { text: "", truncated: false },
						unstagedDiff: { text: "+compatibility adjustment\n", truncated: false },
						untrackedFiles: { text: "", truncated: false },
					},
				],
			},
			repo: {} as never,
		});
		// Keep the rules separate from evidence without pinning whitespace or surrounding copy.
		expect(prompt).toMatch(
			/<formatting_rules>\s*repo:\s*Use type\(scope\)\.\s*<\/formatting_rules>/,
		);
		expect(prompt).toMatch(
			/<accepted_plan>\s*## Plan\s+Ship the durable behavior\.\s*<\/accepted_plan>/,
		);
		expect(prompt).toMatch(
			/<implementation_summary>\s*Implemented the behavior and its compatibility adjustment\.\s*<\/implementation_summary>/,
		);
		expect(prompt).toContain("+compatibility adjustment");
	});

	it.each([
		["repo"],
		["repo_1", "repo_2"],
	])("requires messages for exactly the project keys: %j", (...keys) => {
		const messages = Object.fromEntries(keys.map((key) => [key, "feat: ship change"]));
		expect(parseRepositoryCommitMessages(JSON.stringify(messages), keys)).toEqual(messages);
		expect(() => parseRepositoryCommitMessages("{}", keys)).toThrow(/plain text/);
		expect(() => parseRepositoryCommitMessages(JSON.stringify(messages), [])).toThrow(/Unknown/);
	});

	it("normalizes line endings and rejects wrapper noise", () => {
		expect(normalizeGeneratedCommitMessage(" Ship change\r\n\r\nWhy it matters. \n")).toBe(
			"Ship change\n\nWhy it matters.",
		);
		expect(() => normalizeGeneratedCommitMessage("```\nShip change\n```")).toThrow(/fences/);
		expect(() => normalizeGeneratedCommitMessage("Commit message: Ship change")).toThrow(/prefix/);
		expect(() => normalizeGeneratedCommitMessage("bad\0message")).toThrow(/NUL/);
	});
});
