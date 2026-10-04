import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitForValue } from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createExampleHarness, http, launchProcess } from "./testing/harness.js";

async function createFileTriggerHarness(completePromptPath: string) {
	return createExampleHarness({
		extensionConfig: {
			"example-processes": { file_triggers: { complete_prompt_path: completePromptPath } },
		},
	});
}

let harness: Awaited<ReturnType<typeof createExampleHarness>>;

beforeAll(async () => {
	harness = await createExampleHarness();
});

afterAll(async () => {
	await harness.close();
});

describe("example processes extension", () => {
	it("lists all UI launchers and resolves defaults/options from configured model profiles", async () => {
		const listResponse = await http(harness, `/api/launchers`);
		const listBody = await listResponse.json();
		expect(listResponse.status).toBe(200);
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

		const defaultsResponse = await http(
			harness,
			`/api/launchers/single_prompt_process.single_prompt_ui/defaults`,
		);
		const defaultsBody = await defaultsResponse.json();
		expect(defaultsResponse.status).toBe(200);
		expect(defaultsBody.defaults).toEqual({
			prompt: "",
		});
		expect(defaultsBody.modelConfig).toEqual({
			defaultModelProfileId: null,
			turnConfigs: {},
		});

		const optionsResponse = await http(
			harness,
			`/api/launchers/single_prompt_with_tool_process.single_prompt_with_tool_ui/options`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			},
		);
		const optionsBody = await optionsResponse.json();
		expect(optionsResponse.status).toBe(200);
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

	it("runs a launched single prompt once and completes on turn end without a done tool", async () => {
		const launched = await launchProcess(
			harness,
			"single_prompt_process.single_prompt_ui",
			{ prompt: "Say hello." },
			"local_qwen",
		);
		expect(launched).toMatchObject({
			processId: "single_prompt_process",
			defaultModelProfileId: "local_qwen",
		});

		const process = await waitForValue(
			() => harness.process(launched.id).snapshot().process,
			(value) => value?.lifecycleStatus === "completed",
		);
		expect(process).toMatchObject({
			lifecycleStatus: "completed",
			defaultModelProfileId: "local_qwen",
		});

		const turnRecords = harness.process(launched.id).snapshot().turns;
		expect(turnRecords).toHaveLength(1);
		expect(turnRecords[0]).toMatchObject({
			turnId: "run_single_prompt",
			status: "succeeded",
		});
	});

	it("runs a launched single prompt that explicitly requires the done tool", async () => {
		const launched = await launchProcess(
			harness,
			"single_prompt_with_tool_process.single_prompt_with_tool_ui",
			{ prompt: "Say hello, then confirm completion." },
			"claude_fast",
		);
		expect(launched).toMatchObject({
			processId: "single_prompt_with_tool_process",
			defaultModelProfileId: "claude_fast",
		});

		const process = await waitForValue(
			() => harness.process(launched.id).snapshot().process,
			(value) => value?.lifecycleStatus === "completed",
		);
		expect(process).toMatchObject({
			lifecycleStatus: "completed",
			defaultModelProfileId: "claude_fast",
		});

		const turnRecords = harness.process(launched.id).snapshot().turns;
		expect(turnRecords).toHaveLength(1);
		expect(turnRecords[0]).toMatchObject({
			turnId: "run_single_prompt_with_tool",
			status: "succeeded",
		});
	});

	it("waits on an external turn and completes when the configured prompt-complete file is written", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "o2-example-processes-file-trigger-"));
		onTestFinished(() => rm(dir, { recursive: true, force: true }));
		const completePromptPath = path.join(dir, "complete_prompt");
		const fileTriggerHarness = await createFileTriggerHarness(completePromptPath);
		try {
			const launched = await launchProcess(
				fileTriggerHarness,
				"single_prompt_external_complete_process.single_prompt_external_complete_ui",
				{ prompt: "Say hello, then wait for the external completion trigger." },
				"local_qwen",
			);
			expect(launched.processId).toBe("single_prompt_external_complete_process");

			const waitingProcess = await waitForValue(
				() => fileTriggerHarness.process(launched.id).snapshot().process,
				(value) =>
					value?.selectedTurnId === "await_external_prompt_completion" &&
					value?.lifecycleStatus === "waiting",
			);
			expect(waitingProcess).toMatchObject({
				selectedTurnId: "await_external_prompt_completion",
				lifecycleStatus: "waiting",
			});
			await waitForValue(
				() => fileTriggerHarness.process(launched.id).snapshot().events,
				(events) =>
					events.some(
						(event) =>
							event.eventType === "external_source_armed" &&
							event.data.sourceKind === "@leitwerk-dev/showcase-processes.file.presence",
					),
			);

			const detailResponse = await http(fileTriggerHarness, `/api/processes/${launched.id}`);
			const detailBody = await detailResponse.json();
			expect(detailResponse.status).toBe(200);
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

			const completedProcess = await waitForValue(
				() => ({
					process: fileTriggerHarness.process(launched.id).snapshot().process,
					fileRemoved: !existsSync(completePromptPath),
				}),
				(value) =>
					value.process?.selectedTurnId === null &&
					value.process?.lifecycleStatus === "completed" &&
					value.fileRemoved,
			);
			expect(completedProcess.process).toMatchObject({
				selectedTurnId: null,
				lifecycleStatus: "completed",
			});
			const externalTurnRecords = fileTriggerHarness
				.process(launched.id)
				.snapshot()
				.turns.filter((turnRecord) => turnRecord.turnType === "external");
			expect(externalTurnRecords).toHaveLength(1);
			expect(externalTurnRecords[0]).toMatchObject({
				turnId: "await_external_prompt_completion",
				turnType: "external",
				status: "succeeded",
			});
			expect(fileTriggerHarness.process(launched.id).snapshot().annotations).toEqual(
				expect.arrayContaining([expect.objectContaining({ annotationType: "external_trigger" })]),
			);
		} finally {
			await fileTriggerHarness.close();
		}
	});
});
