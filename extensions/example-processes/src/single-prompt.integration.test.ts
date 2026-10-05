import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createExampleHarness } from "./testing/harness.js";

let harness: Awaited<ReturnType<typeof createExampleHarness>>;

beforeAll(async () => {
	harness = await createExampleHarness();
});

afterAll(async () => {
	await harness.close();
});

describe("example processes extension", () => {
	it("lists all UI launchers and resolves defaults/options from configured model profiles", async () => {
		const listResponse = await harness.request({ url: "/api/launchers" });
		const listBody = await listResponse.json();
		expect(listResponse.statusCode).toBe(200);
		expect(listBody.launchers).toHaveLength(6);
		expect(listBody.launchers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "single_prompt_process.single_prompt_ui",
					processId: "single_prompt_process",
					label: "Single Prompt",
				}),
				expect.objectContaining({
					id: "single_prompt_with_tool_process.single_prompt_with_tool_ui",
					processId: "single_prompt_with_tool_process",
					label: "Single Prompt + Done Tool",
				}),
				expect.objectContaining({
					id: "single_prompt_external_complete_process.single_prompt_external_complete_ui",
					processId: "single_prompt_external_complete_process",
					label: "Single Prompt + External Complete",
				}),
			]),
		);

		const defaultsResponse = await harness.request({
			url: "/api/launchers/single_prompt_process.single_prompt_ui/defaults",
		});
		const defaultsBody = await defaultsResponse.json();
		expect(defaultsResponse.statusCode).toBe(200);
		expect(defaultsBody.defaults).toEqual({
			prompt: "",
		});
		expect(defaultsBody.modelConfig).toEqual({
			defaultModelProfileId: null,
			turnConfigs: {},
		});

		const optionsResponse = await harness.request({
			url: "/api/launchers/single_prompt_with_tool_process.single_prompt_with_tool_ui/options",
			method: "POST",
			payload: {},
		});
		const optionsBody = await optionsResponse.json();
		expect(optionsResponse.statusCode).toBe(200);
		expect(optionsBody.options).toEqual({});
		expect(
			listBody.launchers.find(
				(launcher: { id: string; modelConfigSchema?: unknown }) =>
					launcher.id === "single_prompt_with_tool_process.single_prompt_with_tool_ui",
			),
		).toMatchObject({
			modelConfigSchema: {
				availableProfiles: [
					{
						id: "claude_fast",
						label: "claude_fast — anthropic/claude-sonnet-4-20250514",
						description: "Thinking level: medium",
					},
					{
						id: "local_qwen",
						label: "local_qwen — ollama/qwen2.5-coder:14b",
						description: "Thinking level: low",
					},
				],
				llmTurns: [{ turnId: "run_single_prompt_with_tool" }],
			},
		});
	});

	it.each([
		{
			processId: "single_prompt_process",
			launcherId: "single_prompt_process.single_prompt_ui",
			turnId: "run_single_prompt",
			defaultModelProfileId: "local_qwen",
			prompt: "Say hello.",
		},
		{
			processId: "single_prompt_with_tool_process",
			launcherId: "single_prompt_with_tool_process.single_prompt_with_tool_ui",
			turnId: "run_single_prompt_with_tool",
			defaultModelProfileId: "claude_fast",
			prompt: "Say hello, then confirm completion.",
		},
	])("runs $processId once with model $defaultModelProfileId", async ({
		processId,
		launcherId,
		turnId,
		defaultModelProfileId,
		prompt,
	}) => {
		const launched = await harness.launch(launcherId, { prompt }, { defaultModelProfileId });
		expect(launched.snapshot().process).toMatchObject({ processId, defaultModelProfileId });
		const { process, turns } = await launched.waitFor(
			({ process }) => process.lifecycleStatus === "completed",
		);
		expect(process).toMatchObject({ lifecycleStatus: "completed", defaultModelProfileId });
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ turnId, status: "succeeded" });
	});

	it("waits on an external turn and completes when the configured prompt-complete file is written", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "o2-example-processes-file-trigger-"));
		onTestFinished(() => rm(dir, { recursive: true, force: true }));
		const completePromptPath = path.join(dir, "complete_prompt");
		const fileTriggerHarness = await createExampleHarness({
			extensionConfig: {
				"example-processes": { file_triggers: { complete_prompt_path: completePromptPath } },
			},
		});
		onTestFinished(() => fileTriggerHarness.close());
		const launched = await fileTriggerHarness.launch(
			"single_prompt_external_complete_process.single_prompt_external_complete_ui",
			{ prompt: "Say hello, then wait for the external completion trigger." },
			{ defaultModelProfileId: "local_qwen" },
		);
		expect(launched.snapshot().process.processId).toBe("single_prompt_external_complete_process");

		const waiting = await launched.waitFor(
			({ process }) =>
				process.selectedTurnId === "await_external_prompt_completion" &&
				process.lifecycleStatus === "waiting",
		);
		expect(waiting.process).toMatchObject({
			selectedTurnId: "await_external_prompt_completion",
			lifecycleStatus: "waiting",
		});
		await launched.waitFor(({ events }) =>
			events.some(
				(event) =>
					event.eventType === "external_source_armed" &&
					event.data.sourceKind === "@leitwerk-dev/showcase-processes.file.presence",
			),
		);

		const detailResponse = await fileTriggerHarness.request({
			url: `/api/processes/${launched.id}`,
		});
		const detailBody = await detailResponse.json();
		expect(detailResponse.statusCode).toBe(200);
		expect(detailBody.selectedTurn).toMatchObject({
			turnId: "await_external_prompt_completion",
			kind: "external",
			externalTriggers: [
				expect.objectContaining({
					kind: "@leitwerk-dev/showcase-processes.file.presence",
				}),
			],
		});

		await writeFile(completePromptPath, "complete\n", "utf8");

		const completed = await launched.waitFor(
			({ process }) =>
				process.selectedTurnId === null &&
				process.lifecycleStatus === "completed" &&
				!existsSync(completePromptPath),
		);
		expect(completed.process).toMatchObject({
			selectedTurnId: null,
			lifecycleStatus: "completed",
		});
		const externalTurnRecords = completed.turns.filter((turn) => turn.turnType === "external");
		expect(externalTurnRecords).toHaveLength(1);
		expect(externalTurnRecords[0]).toMatchObject({
			turnId: "await_external_prompt_completion",
			turnType: "external",
			status: "succeeded",
		});
		expect(completed.annotations).toEqual(
			expect.arrayContaining([expect.objectContaining({ annotationType: "external_trigger" })]),
		);
	});
});
