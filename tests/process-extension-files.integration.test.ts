import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import exampleProcessesExtension from "@leitwerk-dev/example-processes";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createExtensionIntegrationHarness,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import { expect, it } from "vitest";

it("routes poem revisions and prompt completion through their owning extensions after restart", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "leitwerk-process-files-"));
	const poemPath = path.join(dir, "poem-{instanceId}");
	const completePath = path.join(dir, "complete");
	const harness = await createExtensionIntegrationHarness({
		extensions: [
			showcaseProcessesExtension,
			exampleProcessesExtension,
			{
				manifest: { id: "process-files-model", version: "1" },
				modelProviders: fixtureModelProviders({
					id: "fixture",
					modelId: "fixture-model",
					server: true,
				}),
			},
		],
		extensionConfig: {
			"showcase-processes": { file_triggers: { poem_review_path: poemPath } },
			"example-processes": { file_triggers: { complete_prompt_path: completePath } },
		},
		models: [{ id: "fixture", provider: "fixture", modelId: "fixture-model" }],
		defaultModel: "fixture",
		script: () => ({
			tools: [{ name: "markdown_result", arguments: { markdown: "A cloud drifts by." } }],
		}),
	});
	try {
		const poem = await harness.launch("poem_creator_process.poem_creator_ui", {
			prompt: "Write a poem.",
		});
		const prompt = await harness.launch(
			"single_prompt_external_complete_process.single_prompt_external_complete_ui",
			{ prompt: "Say hello." },
		);
		await poem.waitFor(
			({ process }) =>
				process.selectedTurnId === "poem_review" && process.lifecycleStatus === "waiting",
		);
		await prompt.waitFor(
			({ process }) =>
				process.selectedTurnId === "await_external_prompt_completion" &&
				process.lifecycleStatus === "waiting",
		);
		await harness.restart();
		const reviewPath = poemPath.replace("{instanceId}", poem.id);
		await writeFile(reviewPath, "Make it rhyme.");
		await writeFile(completePath, "");
		await poem.waitFor(
			({ process, turns }) =>
				process.selectedTurnId === "poem_review" &&
				process.lifecycleStatus === "waiting" &&
				turns.filter((turn) => turn.turnId === "draft_poem" && turn.status === "succeeded")
					.length === 2,
		);
		await prompt.waitFor(({ process }) => process.lifecycleStatus === "completed");
		await waitForValue(
			() => !existsSync(reviewPath) && !existsSync(completePath),
			(consumed) => consumed,
		);
		expect(prompt.snapshot().turns.filter((turn) => turn.turnType === "external")).toHaveLength(1);
	} finally {
		await harness.close();
		await rm(dir, { recursive: true, force: true });
	}
});
