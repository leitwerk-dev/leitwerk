import { describe, expect, it } from "vitest";
import {
	buildGenerateCommitMessagePrompt,
	normalizeGeneratedCommitMessage,
} from "./generate-commit-message.js";

describe("commit-message generation", () => {
	it("separates the accepted plan from launch-pinned repository rules", () => {
		const prompt = buildGenerateCommitMessagePrompt({
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
			input: { plan: "## Plan\n\nShip the durable behavior." },
			repo: {} as never,
		});
		expect(prompt).toContain("<formatting_rules>\nUse type(scope).\n</formatting_rules>");
		expect(prompt).toContain(
			"<accepted_plan>\n## Plan\n\nShip the durable behavior.\n</accepted_plan>",
		);
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
