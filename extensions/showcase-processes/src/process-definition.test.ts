import {
	buildProcessLaunchersForTest,
	buildProcessWatchersForTest,
} from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import {
	poemCreatorProcess,
	singlePromptExternalCompleteProcess,
	singlePromptProcess,
	singlePromptWithToolProcess,
} from "./process-definition.js";
import { buildDefaultPoemPrompt } from "./turns/poem-creator.js";

describe("showcase process launchers", () => {
	it("passes prompt title source fields for the single-prompt launchers", () => {
		for (const [process, launcherId] of [
			[singlePromptProcess, "single_prompt_process.single_prompt_ui"],
			[singlePromptWithToolProcess, "single_prompt_with_tool_process.single_prompt_with_tool_ui"],
			[
				singlePromptExternalCompleteProcess,
				"single_prompt_external_complete_process.single_prompt_external_complete_ui",
			],
		] as const) {
			const launchers = buildProcessLaunchersForTest(process);
			const launcher = launchers?.launchers.get(launcherId);
			expect(launcher?.ui).toBeDefined();
			if (!launcher?.ui) {
				continue;
			}
			const resolved = launcher.ui.resolveLaunchConfig({
				prompt: "  Write something vivid about twilight deployments.  ",
			});
			expect(resolved).toEqual({
				ok: true,
				launchConfig: expect.objectContaining({
					titleSourceFields: [
						{ label: "Prompt", value: "Write something vivid about twilight deployments." },
					],
				}),
			});
		}
	});

	it("declares the poem draft as review-branch input", () => {
		const reviewTurn = poemCreatorProcess.turns.get("review_poem_draft")?.definition;
		expect(reviewTurn?.kind).toBe("llm");
		if (reviewTurn?.kind !== "llm") {
			return;
		}
		expect(reviewTurn.consumedProducts).toContain("poem-draft");
	});

	it("passes prompt title source fields for the poem creator launcher and watcher", () => {
		const launchers = buildProcessLaunchersForTest(poemCreatorProcess);
		const launcher = launchers?.launchers.get("poem_creator_process.poem_creator_ui");
		expect(launcher?.ui).toBeDefined();
		if (!launcher?.ui) {
			return;
		}

		const defaultResolved = launcher.ui.resolveLaunchConfig({ prompt: "   " });
		expect(defaultResolved).toEqual({
			ok: true,
			launchConfig: expect.objectContaining({
				titleSourceFields: [{ label: "Poem Prompt", value: buildDefaultPoemPrompt() }],
			}),
		});

		const watchers = buildProcessWatchersForTest(poemCreatorProcess);
		const watcher = watchers?.watchers.get("create_poem");
		expect(watcher).toBeDefined();
		if (!watcher) {
			return;
		}
		expect(
			watcher.resolveLaunchConfig(
				{
					content: "  Write a short poem about release trains under Berlin rain.  ",
				},
				{},
			),
		).toEqual({
			processId: "poem_creator_process",
			params: { prompt: "Write a short poem about release trains under Berlin rain." },
			titleSourceFields: [
				{
					label: "Poem Prompt",
					value: "Write a short poem about release trains under Berlin rain.",
				},
			],
			startTurnId: "draft_poem",
		});
	});
});
