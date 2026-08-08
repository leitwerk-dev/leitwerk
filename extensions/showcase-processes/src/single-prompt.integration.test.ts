import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "@leitwerk-dev/server";
import { createIntegrationHarness } from "@leitwerk-dev/test-support/integration";
import { createInProcessWorkerSpawn } from "@leitwerk-dev/test-support/worker-testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import singlePromptExtension from "./index.js";
import { poemCreatorProcess } from "./process-definition.js";

const fixtureModelProviderExtension = {
	manifest: { id: "showcase-fixture-providers", version: "1.0.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "anthropic",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("anthropic"),
				server: builtinPiProvider("anthropic"),
				models: () => [{ modelId: "claude-sonnet-4-20250514", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
		{
			definition: defineModelProvider({
				id: "ollama",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("ollama"),
				server: builtinPiProvider("ollama"),
				models: () => [{ modelId: "qwen2.5-coder:14b", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
};

const extensionCatalog = buildExtensionCatalogFromModules([
	singlePromptExtension,
	fixtureModelProviderExtension,
]);

function applyModelProfileConfig(config: LeitwerkConfig) {
	config.pi.model_profiles = [
		{
			id: "claude_fast",
			provider: "anthropic",
			model_id: "claude-sonnet-4-20250514",
			thinking_level: "medium",
		},
		{
			id: "local_qwen",
			provider: "ollama",
			model_id: "qwen2.5-coder:14b",
			thinking_level: "low",
		},
	];
}

function createLeaveFeedbackReviewSpawn() {
	return createInProcessWorkerSpawn({
		extensionCatalog,
		toolCallScriptResolver({ tools }) {
			const toolNames = new Set(tools.map((tool) => tool.name));
			if (toolNames.has("leave_feedback")) {
				const feedback =
					"Strengthen the theme connection, tighten the rhythm, and end with a more vivid final image.";
				return {
					toolName: "leave_feedback",
					args: {
						summary: "The poem needs revision before publication",
						message: `## Review feedback\n\n${feedback}`,
					},
				};
			}
			if (toolNames.has("draft_ready")) {
				return {
					calls: [
						{
							toolName: "markdown_result",
							args: {
								markdown:
									"# Cloud Dusk\n\nEvening servers hum in amber light,\nScaled dreams unfolding into night.",
							},
						},
						{
							toolName: "draft_ready",
							args: { summary: "Poem draft ready for review" },
						},
					],
				};
			}
			const markdownTool = tools.find((tool) => tool.name === "markdown_result");
			const completionTool = tools.find((tool) => tool.name !== "markdown_result");
			if (markdownTool && completionTool) {
				const completionArgs = Object.hasOwn(completionTool.parameters, "markdown")
					? { markdown: "# Result\n\nCompleted.", summary: "Completed" }
					: { summary: "Completed" };
				return {
					calls: [
						{
							toolName: markdownTool.name,
							args: { markdown: "# Result\n\nCompleted." },
						},
						{
							toolName: completionTool.name,
							args: completionArgs,
						},
					],
				};
			}
			if (markdownTool) {
				return {
					toolName: markdownTool.name,
					args: { markdown: "# Result\n\nCompleted." },
				};
			}
			if (completionTool) {
				const args = Object.hasOwn(completionTool.parameters, "markdown")
					? { markdown: "# Result\n\nCompleted.", summary: "Completed" }
					: { summary: "Completed" };
				return { toolName: completionTool.name, args };
			}
			return undefined;
		},
	});
}

async function createLeaveFeedbackReviewHarness() {
	return createIntegrationHarness({
		extensionCatalog,
		appOverrides: {
			localWorkerSpawnImpl: createLeaveFeedbackReviewSpawn(),
		},
		configOverride: applyModelProfileConfig,
	});
}

async function createFileTriggerHarness(paths: {
	poemReviewPath: string;
	completePromptPath: string;
}) {
	const harness = await createIntegrationHarness({
		extensionCatalog,
		inProcessWorkers: true,
		configOverride(config) {
			applyModelProfileConfig(config);
			config.extensions = {
				...(config.extensions ?? {}),
				"showcase-processes": {
					file_triggers: {
						poll_interval: "50ms",
						poem_review_path: paths.poemReviewPath,
						complete_prompt_path: paths.completePromptPath,
					},
				},
			};
		},
	});
	await harness.ctx.startBackgroundServices();
	return harness;
}

async function waitFor<T>(
	read: () => T,
	predicate: (value: T) => boolean,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = read();
		if (predicate(value)) {
			return value;
		}
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for single prompt condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

let harness: Awaited<ReturnType<typeof createIntegrationHarness>>;

beforeAll(async () => {
	harness = await createIntegrationHarness({
		extensionCatalog,
		inProcessWorkers: true,
		configOverride: applyModelProfileConfig,
	});
});

afterAll(async () => {
	await harness.ctx.app.close();
});

describe("single prompt extension", () => {
	it("defines the poem review turn with no_issues and leave_feedback only", () => {
		const turn = poemCreatorProcess.turns.get("review_poem_draft")?.definition;
		expect(turn?.kind).toBe("llm");
		if (turn?.kind !== "llm") {
			throw new Error("expected review_poem_draft to be an LLM turn");
		}
		expect(Object.keys(turn.outcomes ?? {}).sort()).toEqual(["leave_feedback", "no_issues"]);
		expect(turn.resultSemanticRef).toBe("review");
		expect(turn.turnResultMarkdown).toBeUndefined();
		expect(turn.outcomes?.no_issues).toMatchObject({
			publishedProduct: "review",
			turnResultMarkdownParameter: "review",
		});
		expect(turn.outcomes?.leave_feedback).toMatchObject({
			publishedProduct: "message",
			turnResultMarkdownParameter: "message",
		});
	});

	it("lists all UI launchers and resolves defaults/options from configured model profiles", async () => {
		const listResponse = await fetch(`${harness.address}/api/launchers`);
		const listBody = await listResponse.json();
		expect(listResponse.status).toBe(200);
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
				expect.objectContaining({
					id: "poem_creator_process.poem_creator_ui",
					processId: "poem_creator_process",
					label: "Poem Creator",
				}),
			]),
		);

		const defaultsResponse = await fetch(
			`${harness.address}/api/launchers/single_prompt_process.single_prompt_ui/defaults`,
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

		const poemDefaultsResponse = await fetch(
			`${harness.address}/api/launchers/poem_creator_process.poem_creator_ui/defaults`,
		);
		const poemDefaultsBody = await poemDefaultsResponse.json();
		expect(poemDefaultsResponse.status).toBe(200);
		expect(poemDefaultsBody.defaults.prompt).toEqual(expect.stringMatching(/\S/));
		expect(poemDefaultsBody.modelConfig).toEqual({
			defaultModelProfileId: null,
			turnConfigs: {},
		});

		const optionsResponse = await fetch(
			`${harness.address}/api/launchers/single_prompt_with_tool_process.single_prompt_with_tool_ui/options`,
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
		const launchResponse = await fetch(
			`${harness.address}/api/launchers/single_prompt_process.single_prompt_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						prompt: "Say hello.",
					},
					modelConfig: {
						defaultModelProfileId: "local_qwen",
					},
				}),
			},
		);
		const launchBody = await launchResponse.json();
		expect(launchResponse.status).toBe(201);
		expect(launchBody.process).toMatchObject({
			processId: "single_prompt_process",
			lifecycleStatus: "active",
			defaultModelProfileId: "local_qwen",
		});

		const process = await waitFor(
			() => harness.ctx.deps.processes.getById(launchBody.process.id),
			(value) => value?.lifecycleStatus === "completed",
		);
		expect(process).toMatchObject({
			lifecycleStatus: "completed",
			defaultModelProfileId: "local_qwen",
		});

		const turnRecords = harness.ctx.deps.turnRecords.listByInstance(launchBody.process.id);
		expect(turnRecords).toHaveLength(1);
		expect(turnRecords[0]).toMatchObject({
			turnId: "run_single_prompt",
			status: "succeeded",
		});
	});

	it("runs a launched single prompt that explicitly requires the done tool", async () => {
		const launchResponse = await fetch(
			`${harness.address}/api/launchers/single_prompt_with_tool_process.single_prompt_with_tool_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						prompt: "Say hello, then confirm completion.",
					},
					modelConfig: {
						defaultModelProfileId: "claude_fast",
					},
				}),
			},
		);
		const launchBody = await launchResponse.json();
		expect(launchResponse.status).toBe(201);
		expect(launchBody.process).toMatchObject({
			processId: "single_prompt_with_tool_process",
			lifecycleStatus: "active",
			defaultModelProfileId: "claude_fast",
		});

		const process = await waitFor(
			() => harness.ctx.deps.processes.getById(launchBody.process.id),
			(value) => value?.lifecycleStatus === "completed",
		);
		expect(process).toMatchObject({
			lifecycleStatus: "completed",
			defaultModelProfileId: "claude_fast",
		});

		const turnRecords = harness.ctx.deps.turnRecords.listByInstance(launchBody.process.id);
		expect(turnRecords).toHaveLength(1);
		expect(turnRecords[0]).toMatchObject({
			turnId: "run_single_prompt_with_tool",
			status: "succeeded",
		});
	});

	it("waits on an external turn and completes when the configured prompt-complete file is written", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "o2-showcase-processes-file-trigger-"));
		const poemReviewPath = path.join(dir, "poem_review");
		const completePromptPath = path.join(dir, "complete_prompt");
		const fileTriggerHarness = await createFileTriggerHarness({
			poemReviewPath,
			completePromptPath,
		});
		try {
			const launchResponse = await fetch(
				`${fileTriggerHarness.address}/api/launchers/single_prompt_external_complete_process.single_prompt_external_complete_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							prompt: "Say hello, then wait for the external completion trigger.",
						},
						modelConfig: {
							defaultModelProfileId: "local_qwen",
						},
					}),
				},
			);
			const launchBody = await launchResponse.json();
			expect(launchResponse.status).toBe(201);
			expect(launchBody.process.processId).toBe("single_prompt_external_complete_process");

			const waitingProcess = await waitFor(
				() => fileTriggerHarness.ctx.deps.processes.getById(launchBody.process.id),
				(value) =>
					value?.selectedTurnId === "await_external_prompt_completion" &&
					value?.lifecycleStatus === "waiting",
			);
			expect(waitingProcess).toMatchObject({
				selectedTurnId: "await_external_prompt_completion",
				lifecycleStatus: "waiting",
			});
			await waitFor(
				() => fileTriggerHarness.ctx.deps.events.listByInstance(launchBody.process.id, 20),
				(events) =>
					events.some(
						(event) =>
							event.eventType === "external_source_armed" &&
							event.data.sourceKind === "@leitwerk-dev/showcase-processes.file.presence",
					),
			);

			const detailResponse = await fetch(
				`${fileTriggerHarness.address}/api/processes/${launchBody.process.id}`,
			);
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

			const completedProcess = await waitFor(
				() => ({
					process: fileTriggerHarness.ctx.deps.processes.getById(launchBody.process.id),
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
			const externalTurnRecords = fileTriggerHarness.ctx.deps.turnRecords
				.listByInstance(launchBody.process.id)
				.filter((turnRecord) => turnRecord.turnType === "external");
			expect(externalTurnRecords).toHaveLength(1);
			expect(externalTurnRecords[0]).toMatchObject({
				turnId: "await_external_prompt_completion",
				turnType: "external",
				status: "succeeded",
			});
			expect(
				fileTriggerHarness.ctx.deps.turnAnnotations.listByInstance(launchBody.process.id),
			).toEqual(
				expect.arrayContaining([expect.objectContaining({ annotationType: "external_trigger" })]),
			);
		} finally {
			await fileTriggerHarness.ctx.app.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("triggers poem revisions from the configured poem-review file and removes the file", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "o2-poem-review-trigger-"));
		const poemReviewPath = path.join(dir, "poem_review");
		const completePromptPath = path.join(dir, "complete_prompt");
		const fileTriggerHarness = await createFileTriggerHarness({
			poemReviewPath,
			completePromptPath,
		});
		try {
			const launchResponse = await fetch(
				`${fileTriggerHarness.address}/api/launchers/poem_creator_process.poem_creator_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							prompt: "Write a short poem about rain over Berlin rooftops.",
						},
						modelConfig: {
							defaultModelProfileId: "local_qwen",
						},
					}),
				},
			);
			const launchBody = await launchResponse.json();
			expect(launchResponse.status).toBe(201);

			await waitFor(
				() => fileTriggerHarness.ctx.deps.processes.getById(launchBody.process.id),
				(value) => value?.selectedTurnId === "poem_review" && value?.lifecycleStatus === "waiting",
			);
			await waitFor(
				() => fileTriggerHarness.ctx.deps.events.listByInstance(launchBody.process.id, 20),
				(events) =>
					events.some(
						(event) =>
							event.eventType === "external_source_armed" &&
							event.data.armingId === "poem_review:poem_review_file",
					),
			);

			const detailResponse = await fetch(
				`${fileTriggerHarness.address}/api/processes/${launchBody.process.id}`,
			);
			const detailBody = await detailResponse.json();
			expect(detailResponse.status).toBe(200);
			expect(detailBody.selectedTurn).toMatchObject({
				turnId: "poem_review",
				kind: "human",
				externalTriggers: [
					expect.objectContaining({
						id: "poem_review:poem_review_file",
						externalActionId: "poem_review_file",
						kind: "@leitwerk-dev/showcase-processes.file.instruction",
					}),
				],
			});

			await writeFile(poemReviewPath, "Make the imagery softer and more twilight-heavy.", "utf8");

			const afterRevision = await waitFor(
				() => ({
					process: fileTriggerHarness.ctx.deps.processes.getById(launchBody.process.id),
					turnRecords: fileTriggerHarness.ctx.deps.turnRecords.listByInstance(
						launchBody.process.id,
					),
					annotations: fileTriggerHarness.ctx.deps.turnAnnotations.listByInstance(
						launchBody.process.id,
					),
					fileRemoved: !existsSync(poemReviewPath),
				}),
				(value) =>
					value.turnRecords.filter((turnRecord) => turnRecord.turnId === "draft_poem").length >=
						2 &&
					value.turnRecords.some((turnRecord) => turnRecord.turnType === "external") &&
					value.annotations.some(
						(annotation) => annotation.annotationType === "external_trigger",
					) &&
					value.fileRemoved,
			);
			expect(
				afterRevision.turnRecords.filter((turnRecord) => turnRecord.turnId === "draft_poem"),
			).toHaveLength(2);
			expect(
				afterRevision.turnRecords.filter((turnRecord) => turnRecord.turnType === "external"),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ turnId: "poem_review", status: "succeeded" }),
				]),
			);
			expect(afterRevision.annotations).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						annotationType: "external_trigger",
						payload: expect.objectContaining({
							externalActionId: "poem_review_file",
							armingId: "poem_review:poem_review_file",
						}),
					}),
				]),
			);
		} finally {
			await fileTriggerHarness.ctx.app.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("launches poem creator with the default prompt, creates a workspace, and auto-accepts no_issues reviews without redrafting", async () => {
		const defaultsResponse = await fetch(
			`${harness.address}/api/launchers/poem_creator_process.poem_creator_ui/defaults`,
		);
		const defaultsBody = await defaultsResponse.json();
		expect(defaultsResponse.status).toBe(200);

		const launchResponse = await fetch(
			`${harness.address}/api/launchers/poem_creator_process.poem_creator_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						prompt: "",
					},
					modelConfig: {
						defaultModelProfileId: "claude_fast",
					},
				}),
			},
		);
		const launchBody = await launchResponse.json();
		expect(launchResponse.status).toBe(201);
		expect(launchBody.process).toMatchObject({
			processId: "poem_creator_process",
			lifecycleStatus: "active",
			defaultModelProfileId: "claude_fast",
		});

		const firstHumanReview = await waitFor(
			() => harness.ctx.deps.processes.getById(launchBody.process.id),
			(value) => {
				if (!value || value.lifecycleStatus !== "waiting") {
					return false;
				}
				const state = JSON.parse(value.stateJson ?? "null");
				return state?.reviewSubject?.kind === "plan";
			},
		);
		expect(firstHumanReview).toMatchObject({
			lifecycleStatus: "waiting",
		});
		expect(JSON.parse(firstHumanReview?.paramsJson ?? "{}")).toMatchObject({
			prompt: defaultsBody.defaults.prompt,
		});

		const workspaceRoot = path.join(
			harness.config.storage.process_workspaces_dir,
			launchBody.process.id,
		);
		expect(existsSync(workspaceRoot)).toBe(true);

		const initialActionsResponse = await fetch(
			`${harness.address}/api/processes/${launchBody.process.id}/actions`,
		);
		const initialActionsBody = await initialActionsResponse.json();
		expect(initialActionsResponse.status).toBe(200);
		expect(initialActionsBody.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "complete_poem", label: "Complete poem" }),
				expect.objectContaining({ id: "request_poem_revision", label: "Request revision" }),
				expect.objectContaining({ id: "run_poem_auto_review", label: "Run automated review" }),
			]),
		);
		const completePoemAction = initialActionsBody.actions.find(
			(action: { id: string }) => action.id === "complete_poem",
		);
		const requestRevisionAction = initialActionsBody.actions.find(
			(action: { id: string }) => action.id === "request_poem_revision",
		);
		const autoReviewAction = initialActionsBody.actions.find(
			(action: { id: string }) => action.id === "run_poem_auto_review",
		);
		expect(completePoemAction).toMatchObject({
			supportsScheduling: false,
			supportsNextTurnModelOverride: false,
			preview: expect.objectContaining({ kind: "terminal" }),
		});
		expect(requestRevisionAction).toMatchObject({
			supportsScheduling: true,
			supportsNextTurnModelOverride: true,
			preview: expect.objectContaining({ turnId: "draft_poem", turnKind: "llm" }),
		});
		expect(autoReviewAction).toMatchObject({
			supportsScheduling: true,
			supportsNextTurnModelOverride: true,
			preview: expect.objectContaining({ turnId: "review_poem_draft", turnKind: "llm" }),
		});

		const firstTurnRecords = harness.ctx.deps.turnRecords.listByInstance(launchBody.process.id);
		expect(firstTurnRecords).toHaveLength(1);
		expect(firstTurnRecords[0]).toMatchObject({
			turnId: "draft_poem",
			status: "succeeded",
			pathType: "primary",
		});
		expect(firstTurnRecords[0]?.turnResultMarkdown).toEqual(expect.any(String));
		expect(firstTurnRecords[0]?.turnResultMarkdown?.trim().length).toBeGreaterThan(0);

		const runReviewResponse = await fetch(
			`${harness.address}/api/processes/${launchBody.process.id}/actions/run_poem_auto_review`,
			{ method: "POST" },
		);
		expect(runReviewResponse.status).toBe(200);

		const afterAutoAcceptedReview = await waitFor(
			() => ({
				process: harness.ctx.deps.processes.getById(launchBody.process.id),
				draftCount: harness.ctx.deps.turnRecords
					.listByInstance(launchBody.process.id)
					.filter((turnRecord) => turnRecord.turnId === "draft_poem").length,
				inputs: harness.ctx.deps.inputs.listByInstance(launchBody.process.id),
			}),
			(value) => {
				if (
					!value.process ||
					value.process.lifecycleStatus !== "waiting" ||
					value.draftCount !== 1
				) {
					return false;
				}
				const state = JSON.parse(value.process.stateJson ?? "null");
				return state?.reviewSubject?.kind === "plan" && state?.latestReviewOutcome === "no_issues";
			},
		);
		expect(afterAutoAcceptedReview.process).toMatchObject({
			lifecycleStatus: "waiting",
		});
		expect(JSON.parse(afterAutoAcceptedReview.process?.stateJson ?? "null")).toMatchObject({
			reviewSubject: { kind: "plan" },
			latestReviewOutcome: "no_issues",
			latestReviewMarkdown: null,
			latestReviewSummary: expect.any(String),
		});
		expect(afterAutoAcceptedReview.inputs).toHaveLength(0);
		const llmReviewTurnRecordIds = new Set(
			harness.ctx.deps.turnRecords
				.listByInstance(launchBody.process.id)
				.filter((tr) => tr.turnId === "review_poem_draft")
				.map((tr) => tr.id),
		);
		const llmReviewToolCalls = harness.ctx.deps.events
			.listByInstance(launchBody.process.id)
			.filter(
				(event) =>
					llmReviewTurnRecordIds.has(
						(event.data as { turnRecordId?: string }).turnRecordId ?? "",
					) && event.eventType === "pi.tool.call",
			)
			.map((event) => String((event.data as { name?: string }).name));
		expect(llmReviewToolCalls).toEqual(["no_issues"]);

		const reviewActionsResponse = await fetch(
			`${harness.address}/api/processes/${launchBody.process.id}/actions`,
		);
		const reviewActionsBody = await reviewActionsResponse.json();
		expect(reviewActionsResponse.status).toBe(200);
		expect(reviewActionsBody.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "complete_poem", label: "Complete poem" }),
				expect.objectContaining({ id: "request_poem_revision", label: "Request revision" }),
				expect.objectContaining({ id: "run_poem_auto_review", label: "Run automated review" }),
			]),
		);
		expect(reviewActionsBody.actions).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "accept_poem_review" }),
				expect.objectContaining({ id: "request_poem_review_changes" }),
			]),
		);

		const reviewTurnRecords = harness.ctx.deps.turnRecords.listByInstance(launchBody.process.id);
		expect(reviewTurnRecords).toHaveLength(3);
		expect(reviewTurnRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					turnId: "poem_review",
					turnType: "human",
					status: "succeeded",
					pathType: "primary",
				}),
				expect.objectContaining({
					turnId: "review_poem_draft",
					turnType: "llm",
					status: "succeeded",
					pathType: "root_branch",
				}),
			]),
		);
		expect(
			reviewTurnRecords.some((turnRecord) => turnRecord.turnId === "poem_review_feedback"),
		).toBe(false);

		const completeResponse = await fetch(
			`${harness.address}/api/processes/${launchBody.process.id}/actions/complete_poem`,
			{ method: "POST" },
		);
		expect(completeResponse.status).toBe(200);

		const completedProcess = await waitFor(
			() => harness.ctx.deps.processes.getById(launchBody.process.id),
			(value) => value?.lifecycleStatus === "completed",
		);
		expect(completedProcess).toMatchObject({
			lifecycleStatus: "completed",
		});
	});

	it("schedules poem review-loop actions while rejecting terminal poem completion scheduling", async () => {
		const launchResponse = await fetch(
			`${harness.address}/api/launchers/poem_creator_process.poem_creator_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						prompt: "Write a short poem about sunrise over the city skyline.",
					},
					modelConfig: {
						defaultModelProfileId: "local_qwen",
					},
				}),
			},
		);
		const launchBody = await launchResponse.json();
		expect(launchResponse.status).toBe(201);

		await waitFor(
			() => harness.ctx.deps.processes.getById(launchBody.process.id),
			(value) => value?.selectedTurnId === "poem_review" && value?.lifecycleStatus === "waiting",
		);

		const runReviewAt = new Date(Date.now() + 60_000).toISOString();
		const reviewScheduleResponse = await fetch(
			`${harness.address}/api/processes/${launchBody.process.id}/actions/run_poem_auto_review`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					nextTurnModelProfileId: "claude_fast",
					schedule: {
						mode: "once",
						runAt: runReviewAt,
					},
				}),
			},
		);
		const reviewScheduleBody = await reviewScheduleResponse.json();

		expect(reviewScheduleResponse.status).toBe(201);
		expect(reviewScheduleBody.scheduledAction).toMatchObject({
			actionId: "run_poem_auto_review",
			nextTurnModelProfileId: "claude_fast",
			action: {
				supportsScheduling: true,
				supportsNextTurnModelOverride: true,
				preview: expect.objectContaining({
					turnId: "review_poem_draft",
					turnKind: "llm",
				}),
			},
		});

		const scheduledAction = harness.ctx.deps.futureExecutions.getScheduledActionByInstance(
			launchBody.process.id,
		);
		expect(scheduledAction?.actionId).toBe("run_poem_auto_review");
		if (scheduledAction) {
			harness.ctx.deps.futureExecutions.delete(scheduledAction.id);
		}

		const scheduleResponse = await fetch(
			`${harness.address}/api/processes/${launchBody.process.id}/actions/complete_poem`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					schedule: {
						mode: "once",
						runAt: new Date(Date.now() + 120_000).toISOString(),
					},
				}),
			},
		);
		const scheduleBody = await scheduleResponse.json();

		expect(scheduleResponse.status).toBe(400);
		expect(scheduleBody.code).toBe("action_not_schedulable");
	});

	it("sends accepted leave_feedback review back to the primary branch", async () => {
		let issuesHarness: Awaited<ReturnType<typeof createIntegrationHarness>> | null = null;
		try {
			issuesHarness = await createLeaveFeedbackReviewHarness();

			const launchResponse = await fetch(
				`${issuesHarness.address}/api/launchers/poem_creator_process.poem_creator_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							prompt: "Write a short poem about cloud software under an evening sky.",
						},
						modelConfig: {
							defaultModelProfileId: "claude_fast",
						},
					}),
				},
			);
			const launchBody = await launchResponse.json();
			expect(launchResponse.status).toBe(201);

			await waitFor(
				() => issuesHarness?.ctx.deps.processes.getById(launchBody.process.id),
				(value) => {
					if (!value || value.lifecycleStatus !== "waiting") {
						return false;
					}
					const state = JSON.parse(value.stateJson ?? "null");
					return state?.reviewSubject?.kind === "plan";
				},
			);

			const runReviewResponse = await fetch(
				`${issuesHarness.address}/api/processes/${launchBody.process.id}/actions/run_poem_auto_review`,
				{ method: "POST" },
			);
			expect(runReviewResponse.status).toBe(200);

			const humanReviewOfReview = await waitFor(
				() => issuesHarness?.ctx.deps.processes.getById(launchBody.process.id),
				(value) => {
					if (!value || value.lifecycleStatus !== "waiting") {
						return false;
					}
					const state = JSON.parse(value.stateJson ?? "null");
					return state?.reviewSubject?.kind === "implementation";
				},
			);
			expect(JSON.parse(humanReviewOfReview?.stateJson ?? "null")).toMatchObject({
				reviewSubject: { kind: "implementation" },
				latestReviewOutcome: "leave_feedback",
				latestReviewMarkdown: expect.any(String),
			});
			const llmReviewTurnRecordIds = new Set(
				issuesHarness.ctx.deps.turnRecords
					.listByInstance(launchBody.process.id)
					.filter((tr) => tr.turnId === "review_poem_draft")
					.map((tr) => tr.id),
			);
			const llmReviewToolCalls = issuesHarness.ctx.deps.events
				.listByInstance(launchBody.process.id)
				.filter(
					(event) =>
						llmReviewTurnRecordIds.has(
							(event.data as { turnRecordId?: string }).turnRecordId ?? "",
						) && event.eventType === "pi.tool.call",
				)
				.map((event) => String((event.data as { name?: string }).name));
			expect(llmReviewToolCalls).toEqual(["leave_feedback"]);

			const processDetailResponse = await fetch(
				`${issuesHarness.address}/api/processes/${launchBody.process.id}`,
			);
			const processDetailBody = await processDetailResponse.json();
			expect(processDetailResponse.status).toBe(200);
			expect(processDetailBody.toolRenderers).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						toolName: "leave_feedback",
						fields: [
							expect.objectContaining({ kind: "plaintext", path: "message", source: "arguments" }),
						],
					}),
				]),
			);

			const reviewActionsResponse = await fetch(
				`${issuesHarness.address}/api/processes/${launchBody.process.id}/actions`,
			);
			const reviewActionsBody = await reviewActionsResponse.json();
			expect(reviewActionsResponse.status).toBe(200);
			expect(reviewActionsBody.actions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "accept_poem_review", label: "Accept review" }),
					expect.objectContaining({
						id: "request_poem_review_changes",
						label: "Request review changes",
						supportsScheduling: true,
						supportsNextTurnModelOverride: true,
						preview: expect.objectContaining({
							turnId: "review_poem_draft",
							turnKind: "llm",
						}),
					}),
					expect.objectContaining({
						id: "dismiss_poem_review",
						label: "Dismiss review",
						supportsScheduling: false,
						supportsNextTurnModelOverride: false,
						preview: expect.objectContaining({
							turnId: "poem_review",
							turnKind: "human",
						}),
					}),
				]),
			);

			const reviewTurnRecords = issuesHarness.ctx.deps.turnRecords.listByInstance(
				launchBody.process.id,
			);
			expect(reviewTurnRecords).toHaveLength(3);

			const acceptReviewResponse = await fetch(
				`${issuesHarness.address}/api/processes/${launchBody.process.id}/actions/accept_poem_review`,
				{ method: "POST" },
			);
			expect(acceptReviewResponse.status).toBe(200);

			const afterAcceptedReview = await waitFor(
				() => ({
					process: issuesHarness?.ctx.deps.processes.getById(launchBody.process.id),
					draftCount: issuesHarness?.ctx.deps.turnRecords
						.listByInstance(launchBody.process.id)
						.filter((turnRecord) => turnRecord.turnId === "draft_poem").length,
					inputs: issuesHarness?.ctx.deps.inputs.listByInstance(launchBody.process.id) ?? [],
				}),
				(value) => {
					if (
						!value.process ||
						value.process.lifecycleStatus !== "waiting" ||
						value.draftCount !== 2
					) {
						return false;
					}
					const state = JSON.parse(value.process.stateJson ?? "null");
					return state?.reviewSubject?.kind === "plan";
				},
			);
			expect(afterAcceptedReview.process).toMatchObject({
				lifecycleStatus: "waiting",
			});
			expect(afterAcceptedReview.inputs).toEqual([]);
			const afterAcceptTurnRecords = issuesHarness.ctx.deps.turnRecords.listByInstance(
				launchBody.process.id,
			);
			const acceptedReviewDrafts = afterAcceptTurnRecords.filter(
				(turnRecord) => turnRecord.turnId === "draft_poem",
			);
			expect(acceptedReviewDrafts).toHaveLength(2);
			expect(acceptedReviewDrafts[1]).toMatchObject({
				pathType: "primary",
				forkPiEntryId: acceptedReviewDrafts[0]?.resultPiEntryId,
			});
			expect(afterAcceptTurnRecords).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						turnId: "poem_review_feedback",
						turnType: "human",
						status: "succeeded",
					}),
				]),
			);
		} finally {
			if (issuesHarness) {
				await issuesHarness.ctx.supervisor.shutdownAll("test_cleanup");
				await issuesHarness.ctx.app.close();
			}
		}
	});

	it("supports a human revision loop for poem creator before returning to review", async () => {
		const launchResponse = await fetch(
			`${harness.address}/api/launchers/poem_creator_process.poem_creator_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						prompt: "Write a short poem about crafting cloud software at dusk.",
					},
					modelConfig: {
						defaultModelProfileId: "local_qwen",
					},
				}),
			},
		);
		const launchBody = await launchResponse.json();
		expect(launchResponse.status).toBe(201);

		await waitFor(
			() => harness.ctx.deps.processes.getById(launchBody.process.id),
			(value) => value?.lifecycleStatus === "waiting",
		);

		const revisionResponse = await fetch(
			`${harness.address}/api/processes/${launchBody.process.id}/actions/request_poem_revision`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					input: {
						message: "Make it calmer, more twilight-colored, and a little more precise.",
					},
				}),
			},
		);
		expect(revisionResponse.status).toBe(200);

		const rerun = await waitFor(
			() => ({
				process: harness.ctx.deps.processes.getById(launchBody.process.id),
				draftCount: harness.ctx.deps.turnRecords
					.listByInstance(launchBody.process.id)
					.filter((turnRecord) => turnRecord.turnId === "draft_poem").length,
			}),
			(value) => {
				if (
					!value.process ||
					value.process.lifecycleStatus !== "waiting" ||
					value.draftCount !== 2
				) {
					return false;
				}
				const state = JSON.parse(value.process.stateJson ?? "null");
				return state?.reviewSubject?.kind === "plan";
			},
		);
		expect(rerun.process).toMatchObject({
			lifecycleStatus: "waiting",
			defaultModelProfileId: "local_qwen",
		});
		expect(JSON.parse(rerun.process?.stateJson ?? "null")).toMatchObject({
			reviewSubject: { kind: "plan" },
		});

		const turnRecords = harness.ctx.deps.turnRecords.listByInstance(launchBody.process.id);
		const draftTurnRecords = turnRecords.filter((turnRecord) => turnRecord.turnId === "draft_poem");
		expect(draftTurnRecords).toHaveLength(2);
		expect(draftTurnRecords[1]).toMatchObject({
			pathType: "primary",
			forkPiEntryId: draftTurnRecords[0]?.resultPiEntryId,
		});
		expect(turnRecords).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					turnId: "poem_review",
					turnType: "human",
					status: "succeeded",
				}),
			]),
		);
	});

	it("continues llm review on the same review branch when a human requests review changes", async () => {
		let issuesHarness: Awaited<ReturnType<typeof createIntegrationHarness>> | null = null;
		try {
			issuesHarness = await createLeaveFeedbackReviewHarness();

			const launchResponse = await fetch(
				`${issuesHarness.address}/api/launchers/poem_creator_process.poem_creator_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							prompt: "Write a short poem about rain over Berlin rooftops.",
						},
						modelConfig: {
							defaultModelProfileId: "claude_fast",
						},
					}),
				},
			);
			const launchBody = await launchResponse.json();
			expect(launchResponse.status).toBe(201);

			await waitFor(
				() => issuesHarness?.ctx.deps.processes.getById(launchBody.process.id),
				(value) => {
					if (!value || value.lifecycleStatus !== "waiting") {
						return false;
					}
					const state = JSON.parse(value.stateJson ?? "null");
					return state?.reviewSubject?.kind === "plan";
				},
			);

			const runReviewResponse = await fetch(
				`${issuesHarness.address}/api/processes/${launchBody.process.id}/actions/run_poem_auto_review`,
				{ method: "POST" },
			);
			expect(runReviewResponse.status).toBe(200);

			await waitFor(
				() => issuesHarness?.ctx.deps.processes.getById(launchBody.process.id),
				(value) => {
					if (!value || value.lifecycleStatus !== "waiting") {
						return false;
					}
					const state = JSON.parse(value.stateJson ?? "null");
					return state?.reviewSubject?.kind === "implementation";
				},
			);

			const recordsAfterFirstReview = issuesHarness.ctx.deps.turnRecords.listByInstance(
				launchBody.process.id,
			);
			const firstDraft = recordsAfterFirstReview.find(
				(turnRecord) => turnRecord.turnId === "draft_poem",
			);
			const firstReview = recordsAfterFirstReview
				.filter((turnRecord) => turnRecord.turnId === "review_poem_draft")
				.at(-1);
			expect(firstReview).toMatchObject({
				pathType: "root_branch",
				forkPiEntryId: firstDraft?.resultPiEntryId,
			});

			const requestChangesResponse = await fetch(
				`${issuesHarness.address}/api/processes/${launchBody.process.id}/actions/request_poem_review_changes`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						input: {
							message:
								"Keep the same review branch, but make the review sharper and more concrete.",
						},
					}),
				},
			);
			expect(requestChangesResponse.status).toBe(200);

			const afterRerun = await waitFor(
				() => ({
					process: issuesHarness?.ctx.deps.processes.getById(launchBody.process.id),
					reviewTurns: issuesHarness?.ctx.deps.turnRecords
						.listByInstance(launchBody.process.id)
						.filter((turnRecord) => turnRecord.turnId === "review_poem_draft"),
					draftTurns: issuesHarness?.ctx.deps.turnRecords
						.listByInstance(launchBody.process.id)
						.filter((turnRecord) => turnRecord.turnId === "draft_poem"),
				}),
				(value) => {
					if (!value.process || value.reviewTurns.length !== 2 || value.draftTurns.length !== 1) {
						return false;
					}
					const state = JSON.parse(value.process.stateJson ?? "null");
					return (
						value.process.lifecycleStatus === "waiting" &&
						state?.reviewSubject?.kind === "implementation"
					);
				},
			);

			const secondReview = afterRerun.reviewTurns.at(-1);
			expect(secondReview).toMatchObject({
				turnId: "review_poem_draft",
				status: "succeeded",
				pathType: "root_branch",
				forkPiEntryId: firstReview?.resultPiEntryId,
			});
			expect(JSON.parse(afterRerun.process?.stateJson ?? "null")).toMatchObject({
				reviewSubject: { kind: "implementation" },
			});
		} finally {
			if (issuesHarness) {
				await issuesHarness.ctx.supervisor.shutdownAll("test_cleanup");
				await issuesHarness.ctx.app.close();
			}
		}
	});
});
