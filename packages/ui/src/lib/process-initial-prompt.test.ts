import { describe, expect, it } from "vitest";
import {
	extractInitialPromptFromParamsJson,
	extractInitialPromptFromValue,
} from "./process-initial-prompt.js";

describe("extractInitialPromptFromValue", () => {
	it("returns null for non-record inputs", () => {
		expect(extractInitialPromptFromValue(null)).toBeNull();
		expect(extractInitialPromptFromValue("prompt")).toBeNull();
		expect(extractInitialPromptFromValue(42)).toBeNull();
		expect(extractInitialPromptFromValue(["prompt"])).toBeNull();
	});

	it("prefers higher-priority fields over lower-priority ones", () => {
		expect(
			extractInitialPromptFromValue({
				command: "echo run",
				prompt: "implement the feature",
			}),
		).toBe("implement the feature");
	});

	it("falls back to lower-priority fields when preferred ones are absent", () => {
		expect(extractInitialPromptFromValue({ defaultCwd: "/repo", command: "ls -la" })).toBe(
			"ls -la",
		);
	});

	it("matches field names case-insensitively", () => {
		expect(extractInitialPromptFromValue({ Prompt: "Mixed case prompt" })).toBe(
			"Mixed case prompt",
		);
	});

	it("collapses whitespace runs into single spaces", () => {
		expect(extractInitialPromptFromValue({ prompt: "  build\n\tthe   archive  " })).toBe(
			"build the archive",
		);
	});

	it("treats blank or whitespace-only values as missing", () => {
		expect(extractInitialPromptFromValue({ prompt: "   ", command: "echo done" })).toBe(
			"echo done",
		);
		expect(extractInitialPromptFromValue({ prompt: "" })).toBeNull();
	});

	it("ignores non-string field values", () => {
		expect(extractInitialPromptFromValue({ prompt: 123, command: "echo ok" })).toBe("echo ok");
	});

	it("does not surface prompt-like fields from nested objects", () => {
		// handoffSource.instruction is not the launch prompt; surfacing it would
		// mislead archive search. A clean miss is preferred over a wrong answer.
		expect(
			extractInitialPromptFromValue({
				repoLocator: "git@example.com:team/repo.git",
				handoffSource: { instruction: "follow the upstream analysis" },
			}),
		).toBeNull();
	});
});

describe("extractInitialPromptFromParamsJson", () => {
	it("returns null for null params", () => {
		expect(extractInitialPromptFromParamsJson(null)).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(extractInitialPromptFromParamsJson("{")).toBeNull();
	});

	it("extracts a top-level prompt from serialized params", () => {
		expect(extractInitialPromptFromParamsJson(JSON.stringify({ prompt: "ship it" }))).toBe(
			"ship it",
		);
	});
});
