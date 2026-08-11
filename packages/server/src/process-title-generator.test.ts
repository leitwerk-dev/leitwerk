import { parseFutureLaunchPayloadJson, serializeFutureLaunchPayload } from "@leitwerk-dev/protocol";
import { waitForValue as waitFor } from "@leitwerk-dev/test-support/integration";
import { describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import {
	buildProcessTitlePrompt,
	buildProcessTitleRetryPolicy,
	buildProcessTitleSourceFields,
	computeProcessTitleRetryDelayMs,
	createProcessTitleGenerator,
	normalizeProcessTitle,
	type ProcessTitleGeneratorRuntimeDeps,
} from "./process-title-generator.js";
import { createProcessTitleLaunchPlan as createLaunchPlan } from "./test-helpers/process-title-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

function parseFutureLaunchPayloadOrThrow(payloadJson: string) {
	const parsed = parseFutureLaunchPayloadJson(payloadJson);
	if (!parsed.ok) {
		throw new Error(parsed.error);
	}
	return parsed.value;
}

function createGeneratorHarness(
	options: {
		titleText?: string;
		delayMs?: number;
		configure?: (config: ReturnType<typeof getDefaultConfig>) => void;
	} = {},
) {
	const deps = createTestDeps();
	const config = getDefaultConfig();
	config.pi.model_profiles = [
		{ id: "claude_fast", provider: "anthropic", model_id: "claude-test" },
	];
	config.pi.process_title_generation.model_profile = "claude_fast";
	options.configure?.(config);
	const titleText = options.titleText ?? "Generated process title";
	const delayMs = options.delayMs ?? 0;
	let activeRequests = 0;
	let maxActiveRequests = 0;
	let completionCallCount = 0;
	let lastGenerationInput: Parameters<ProcessTitleGeneratorRuntimeDeps["generateTitle"]>[0] | null =
		null;
	const emittedExtensionEvents: Array<{ event: string; payload: unknown }> = [];

	const runtime = {
		async generateTitle(input) {
			lastGenerationInput = input;
			completionCallCount += 1;
			activeRequests += 1;
			maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
			activeRequests -= 1;
			return titleText;
		},
		defer(work) {
			work();
			return {};
		},
		pollIntervalMs: 5,
	} satisfies Partial<ProcessTitleGeneratorRuntimeDeps>;

	const generator = createProcessTitleGenerator({
		config,
		repos: deps,
		broadcaster: deps.broadcaster,
		runtime,
		futureExecutionTitleApplier: async (input) => {
			const current = deps.futureExecutions.getById(input.futureExecutionId);
			if (!current || current.payloadJson !== input.expectedPayloadJson) {
				return { kind: "superseded" };
			}
			const parsed = parseFutureLaunchPayloadJson(current.payloadJson);
			if (!parsed.ok) return { kind: "failed", error: parsed.error };
			const updated = deps.futureExecutions.updatePayloadJsonIfUnchanged(
				current.id,
				current.payloadJson,
				serializeFutureLaunchPayload({
					...parsed.value,
					launchPlan: {
						...parsed.value.launchPlan,
						processInput: {
							...parsed.value.launchPlan.processInput,
							title: input.title,
						},
					},
				}),
			);
			return updated ? { kind: "applied" } : { kind: "superseded" };
		},
		extensionHost: {
			on() {},
			off() {},
			async emit(event, payload) {
				emittedExtensionEvents.push({ event, payload });
			},
		},
	});

	return {
		deps,
		generator,
		getCompletionCallCount() {
			return completionCallCount;
		},
		getMaxActiveRequests() {
			return maxActiveRequests;
		},
		getLastGenerationInput() {
			return lastGenerationInput;
		},
		emittedExtensionEvents,
	};
}

describe("process title retry policy", () => {
	it("caps exponential backoff delays", () => {
		const config = getDefaultConfig();
		config.pi.process_title_generation.retry = {
			max_attempts: 6,
			base_delay: "5s",
			max_delay: "30s",
		};
		const policy = buildProcessTitleRetryPolicy(config);

		expect(computeProcessTitleRetryDelayMs(1, policy)).toBe(5_000);
		expect(computeProcessTitleRetryDelayMs(2, policy)).toBe(10_000);
		expect(computeProcessTitleRetryDelayMs(3, policy)).toBe(20_000);
		expect(computeProcessTitleRetryDelayMs(4, policy)).toBe(30_000);
		expect(computeProcessTitleRetryDelayMs(5, policy)).toBe(30_000);
	});
});

describe("normalizeProcessTitle", () => {
	it("trims formatting noise and keeps the title single-line", () => {
		expect(normalizeProcessTitle('  Title:  "Implement sidebar"  ')).toBe("Implement sidebar");
		expect(normalizeProcessTitle("\n- Tighten rollout plan\n")).toBe("Tighten rollout plan");
	});

	it("truncates overly long titles at a word boundary", () => {
		const title = normalizeProcessTitle(
			"Implement a very long sidebar title that keeps rambling past what should be shown to operators in a compact list view",
		);
		expect(title).not.toBeNull();
		expect(title?.length).toBeLessThanOrEqual(80);
		expect(title?.endsWith("…")).toBe(true);
	});

	it("returns null for blank titles", () => {
		expect(normalizeProcessTitle("   ")).toBeNull();
	});
});

describe("buildProcessTitleSourceFields", () => {
	it("uses launcher-defined title source fields in order", () => {
		const fields = buildProcessTitleSourceFields(createLaunchPlan());
		expect(fields).toEqual([
			{
				label: "Prompt",
				value: "Implement a collapsible sidebar for the process list.",
			},
		]);
	});

	it("drops blank values, truncates long content, and deduplicates repeated fields", () => {
		const fields = buildProcessTitleSourceFields(
			createLaunchPlan({
				titleSourceFields: [
					{ label: "Prompt", value: "   " },
					{
						label: "Prompt",
						value:
							"Implement a very long sidebar title source field that keeps rambling far beyond what should be forwarded to a concise title-generation prompt for operators",
					},
					{
						label: "Prompt",
						value:
							"Implement a very long sidebar title source field that keeps rambling far beyond what should be forwarded to a concise title-generation prompt for operators",
					},
				],
			}),
		);
		expect(fields).toHaveLength(1);
		expect(fields[0]?.label).toBe("Prompt");
		expect(fields[0]?.value.length).toBeLessThanOrEqual(240);
	});

	it("returns no fields when the launcher did not define any", () => {
		expect(buildProcessTitleSourceFields(createLaunchPlan({ titleSourceFields: [] }))).toEqual([]);
	});
});

describe("buildProcessTitlePrompt", () => {
	it("includes process context and prompt-like fields", () => {
		const prompt = buildProcessTitlePrompt(
			createLaunchPlan({
				processInput: {
					...createLaunchPlan().processInput,
					externalId: "CLD-123",
				},
			}),
		);
		expect(prompt).toContain("Process id: local_repo_change_process");
		expect(prompt).toContain("External reference: CLD-123");
		expect(prompt).toContain("- Prompt: Implement a collapsible sidebar for the process list.");
	});

	it("returns null when no launcher-defined title fields are available", () => {
		expect(buildProcessTitlePrompt(createLaunchPlan({ titleSourceFields: [] }))).toBeNull();
	});
});

describe("createProcessTitleGenerator", () => {
	it("updates a persisted process title asynchronously when the launch plan left it blank", async () => {
		const harness = createGeneratorHarness({ titleText: "Generated process title" });
		const process = harness.deps.processes.create(createLaunchPlan().processInput);

		harness.generator.queueProcessTitleGeneration?.({
			processId: process.id,
			launchPlan: createLaunchPlan(),
		});

		await waitFor(
			() => harness.deps.processes.getById(process.id)?.title,
			(value) => value === "Generated process title",
		);
		await harness.generator.close?.();
		expect(harness.getCompletionCallCount()).toBe(1);
	});

	it("emits a process-updated extension event when applying a generated process title", async () => {
		const harness = createGeneratorHarness({ titleText: "Generated process title" });
		const process = harness.deps.processes.create(createLaunchPlan().processInput);

		harness.generator.queueProcessTitleGeneration?.({
			processId: process.id,
			launchPlan: createLaunchPlan(),
		});

		await waitFor(
			() => harness.emittedExtensionEvents,
			(events) => events.some((entry) => entry.event === "process_updated"),
		);
		await harness.generator.close?.();
		expect(harness.emittedExtensionEvents).toContainEqual({
			event: "process_updated",
			payload: expect.objectContaining({
				instanceId: process.id,
				changedFields: ["title"],
				process: expect.objectContaining({ title: "Generated process title" }),
			}),
		});
	});

	it("skips generation when the launch plan already supplied an explicit title", async () => {
		const harness = createGeneratorHarness();
		const process = harness.deps.processes.create(
			createLaunchPlan({
				processInput: {
					...createLaunchPlan().processInput,
					title: "Ticket issue summary",
				},
			}).processInput,
		);

		harness.generator.queueProcessTitleGeneration?.({
			processId: process.id,
			launchPlan: createLaunchPlan({
				processInput: {
					...createLaunchPlan().processInput,
					title: "Ticket issue summary",
				},
			}),
		});

		await harness.generator.close?.();
		expect(harness.getCompletionCallCount()).toBe(0);
		expect(harness.deps.processes.getById(process.id)?.title).toBe("Ticket issue summary");
	});

	it("caps title output", async () => {
		const harness = createGeneratorHarness();
		const process = harness.deps.processes.create(createLaunchPlan().processInput);

		harness.generator.queueProcessTitleGeneration({
			processId: process.id,
			launchPlan: createLaunchPlan(),
		});

		await waitFor(
			() => harness.deps.processes.getById(process.id)?.title,
			(value) => value === "Generated process title",
		);
		await harness.generator.close?.();
		expect(harness.getLastGenerationInput()?.maxTokens).toBe(48);
	});

	it("does not overwrite a scheduled launch payload after it has changed", async () => {
		const harness = createGeneratorHarness({ titleText: "Generated future title", delayMs: 20 });
		const originalPayloadJson = serializeFutureLaunchPayload({
			launcherInput: { repoPath: "/tmp/repo" },
			modelConfig: {},
			launchPlan: createLaunchPlan(),
		});
		const futureExecution = harness.deps.futureExecutions.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "local_repo_change_process",
			launcherId: "local_repo_change_process.ui_launcher",
			payloadJson: originalPayloadJson,
			nextRunAt: "2026-04-25T09:00:00.000Z",
		});

		harness.generator.queueFutureExecutionTitleGeneration?.({
			futureExecutionId: futureExecution.id,
			launchPlan: createLaunchPlan(),
			expectedPayloadJson: originalPayloadJson,
		});

		harness.deps.futureExecutions.update(futureExecution.id, {
			payloadJson: serializeFutureLaunchPayload({
				launcherInput: { repoPath: "/tmp/repo" },
				modelConfig: {},
				launchPlan: {
					...createLaunchPlan(),
					processInput: {
						...createLaunchPlan().processInput,
						title: "Manual scheduled title",
					},
				},
			}),
		});

		await waitFor(
			() => harness.getCompletionCallCount(),
			(value) => value === 1,
		);
		await harness.generator.close?.();
		expect(
			parseFutureLaunchPayloadOrThrow(
				harness.deps.futureExecutions.getById(futureExecution.id)?.payloadJson ?? "",
			).launchPlan.processInput.title,
		).toBe("Manual scheduled title");
	});

	it("generates a scheduled launch title when stored payloads omit defaultable fields", async () => {
		const harness = createGeneratorHarness({ titleText: "Generated future title" });
		const launchPlan = createLaunchPlan();
		const payloadJson = JSON.stringify({
			launchPlan: {
				launcherId: launchPlan.launcherId,
				processId: launchPlan.processId,
				processInput: {
					processId: launchPlan.processInput.processId,
					selectedTurnId: launchPlan.processInput.selectedTurnId,
					lifecycleStatus: launchPlan.processInput.lifecycleStatus,
					paramsJson: launchPlan.processInput.paramsJson,
					stateJson: launchPlan.processInput.stateJson,
				},
			},
		});
		const futureExecution = harness.deps.futureExecutions.create({
			kind: "launch",
			scheduleKind: "once",
			processId: launchPlan.processId,
			launcherId: launchPlan.launcherId,
			payloadJson,
			nextRunAt: "2026-04-25T09:00:00.000Z",
		});

		harness.generator.queueFutureExecutionTitleGeneration?.({
			futureExecutionId: futureExecution.id,
			launchPlan,
			expectedPayloadJson: payloadJson,
		});

		await waitFor(
			() =>
				parseFutureLaunchPayloadOrThrow(
					harness.deps.futureExecutions.getById(futureExecution.id)?.payloadJson ?? "",
				).launchPlan.processInput.title,
			(value) => value === "Generated future title",
		);
		await harness.generator.close?.();
	});

	it("runs title generations serially", async () => {
		const harness = createGeneratorHarness({
			titleText: "Generated process title",
			delayMs: 20,
		});
		const processes = [
			harness.deps.processes.create(createLaunchPlan().processInput),
			harness.deps.processes.create(createLaunchPlan().processInput),
			harness.deps.processes.create(createLaunchPlan().processInput),
		];

		for (const process of processes) {
			harness.generator.queueProcessTitleGeneration({
				processId: process.id,
				launchPlan: createLaunchPlan(),
			});
		}

		await waitFor(
			() => processes.map((process) => harness.deps.processes.getById(process.id)?.title),
			(titles) => titles.every((title) => title === "Generated process title"),
			2_000,
		);
		await harness.generator.close?.();
		expect(harness.getCompletionCallCount()).toBe(3);
		expect(harness.getMaxActiveRequests()).toBe(1);
	});
});
