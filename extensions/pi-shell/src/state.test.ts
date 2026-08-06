import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	createInitialPiShellState,
	normalizePromptInput,
	normalizeWorkingDirectory,
	piShellParamsCodec,
	piShellStateCodec,
	stateWithPendingPiShellPrompt,
} from "./state.js";

describe("pi-shell state", () => {
	it("normalizes launch params", () => {
		expect(normalizeWorkingDirectory(".")).toBe(path.resolve("."));
		expect(piShellParamsCodec.parse({ workingDirectory: "./repo", initialPrompt: " hi " })).toEqual(
			{
				workingDirectory: path.resolve("./repo"),
				initialPrompt: "hi",
			},
		);
	});

	it("normalizes prompts and rejects empty pending prompts", () => {
		expect(normalizePromptInput("  fix dev  ")).toBe("fix dev");
		expect(normalizePromptInput("  ")).toBeNull();
		expect(() =>
			stateWithPendingPiShellPrompt({
				state: { workingDirectory: "/tmp/repo", pendingPrompt: null },
				prompt: "",
			}),
		).toThrow();
	});

	it("stores the initial and follow-up pending prompts", () => {
		const initial = createInitialPiShellState({
			workingDirectory: "/tmp/repo",
			initialPrompt: "repair",
		});
		expect(initial).toEqual({ workingDirectory: "/tmp/repo", pendingPrompt: "repair" });

		expect(stateWithPendingPiShellPrompt({ state: initial, prompt: "continue" })).toEqual({
			workingDirectory: "/tmp/repo",
			pendingPrompt: "continue",
		});
	});

	it("drops malformed persisted pending prompts", () => {
		expect(
			piShellStateCodec.parse({
				workingDirectory: "/tmp/repo",
				pendingPrompt: "  ",
			}),
		).toEqual({ workingDirectory: "/tmp/repo", pendingPrompt: null });
	});
});
