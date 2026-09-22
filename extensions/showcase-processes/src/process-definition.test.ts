import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	poemCreatorProcess,
	singlePromptExternalCompleteProcess,
	singlePromptProcess,
	singlePromptWithToolProcess,
} from "./process-definition.js";
import { buildDefaultPoemPrompt } from "./turns/poem-creator.js";

describe("showcase process launchers", () => {
	it("passes prompt title source fields for the single-prompt launchers", async () => {
		const test = await createExtensionTestHarness();
		onTestFinished(() => test.close());
		for (const [process, launcherId] of [
			[singlePromptProcess, "single_prompt_process.single_prompt_ui"],
			[singlePromptWithToolProcess, "single_prompt_with_tool_process.single_prompt_with_tool_ui"],
			[
				singlePromptExternalCompleteProcess,
				"single_prompt_external_complete_process.single_prompt_external_complete_ui",
			],
		] as const) {
			const resolved = await test
				.process(process, { params: { prompt: "Fixture" } })
				.resolveLaunch(launcherId, {
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

	it("declares the poem draft as review-branch input", async () => {
		const test = await createExtensionTestHarness();
		onTestFinished(() => test.close());
		const process = test.process(poemCreatorProcess, { params: { prompt: "Fixture" } });
		expect(
			process.describe().turns.find((turn) => turn.id === "review_poem_draft")?.consumedProducts,
		).toContain("poem-draft");
	});

	it("passes prompt title source fields for the poem creator launcher and watcher", async () => {
		const test = await createExtensionTestHarness();
		onTestFinished(() => test.close());
		const process = test.process(poemCreatorProcess, { params: { prompt: "Fixture" } });
		const defaultResolved = await process.resolveLaunch("poem_creator_process.poem_creator_ui", {
			prompt: "   ",
		});
		expect(defaultResolved).toEqual({
			ok: true,
			launchConfig: expect.objectContaining({
				titleSourceFields: [{ label: "Poem Prompt", value: buildDefaultPoemPrompt() }],
			}),
		});

		expect(
			await process.resolveWatcherLaunch(
				"create_poem",
				{
					content: "  Write a short poem about release trains under Berlin rain.  ",
				},
				{ enabled: true, poll_interval: "1s", file_path: "/tmp/poem-fixture" },
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
