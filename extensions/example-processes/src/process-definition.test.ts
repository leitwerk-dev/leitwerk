import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	singlePromptExternalCompleteProcess,
	singlePromptProcess,
	singlePromptWithToolProcess,
} from "./process-definition.js";

describe("example process launchers", () => {
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
});
