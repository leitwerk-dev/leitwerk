import {
	buildFailedTurnRecoveryMetadata,
	formatPathTypeLabel,
	type QuestionAnswerDraft,
} from "@leitwerk-dev/domain";
import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import {
	type CoreServerSetupDeps,
	createEventBus,
	type LauncherModelConfigPreviewLike,
	type LauncherModelConfigSchemaLike,
	type ModelProfileOptionSummaryLike,
	type ProcessActionModelPreviewLike,
	type ProcessActionSummaryLike,
	type ProcessLaunchPlan,
	type ProcessModelSelectionPreviewResultLike,
	type ProcessModelSelectionServiceLike,
	type UiLauncherSummary,
} from "@leitwerk-dev/process-sdk";
import { createTestQuestion, createTestQuestionRequest } from "@leitwerk-dev/test-support/fixtures";
import { createTestServerSetupCapability } from "@leitwerk-dev/test-support/integration";
import { flushAsyncWork } from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_ACTOR } from "./actor.js";
import { TelegramBridge } from "./bridge.js";
import type { TelegramExtensionConfig } from "./config.js";
import { FakeTelegramClient } from "./fake-telegram-client.js";

type MutableTelegramBridgeInternals = {
	processModelSelection: ProcessModelSelectionServiceLike | null;
	input: {
		config: TelegramExtensionConfig;
		deps: {
			processes: {
				getById: (id: string) => ReturnType<typeof createTestProcessInstance> | null;
			};
		};
	};
};

function bridgeInternals(bridge: TelegramBridge): MutableTelegramBridgeInternals {
	return bridge as unknown as MutableTelegramBridgeInternals;
}

type ProcessLaunchPlanModelConfig = {
	defaultModelProfileId?: string | null;
	turnConfigs?: Record<string, { modelProfileId?: string | null }>;
};

function testConfig(overrides: Partial<TelegramExtensionConfig> = {}): TelegramExtensionConfig {
	const base: TelegramExtensionConfig = {
		enabled: true,
		botToken: "token",
		allowUserIds: [123],
		delivery: { forumChatId: "-100" },
		markdown: { maxChars: 3900 },
		topicTitleTemplate: "{title} · {shortId}",
		actionModelSelection: { enabled: true },
		allowedModelProfileIds: [],
	};
	return {
		...base,
		...overrides,
		delivery: { ...base.delivery, ...(overrides.delivery ?? {}) },
		markdown: { ...base.markdown, ...(overrides.markdown ?? {}) },
		actionModelSelection: {
			...base.actionModelSelection,
			...(overrides.actionModelSelection ?? {}),
		},
	};
}

function createDeps(input: {
	process: ReturnType<typeof createTestProcessInstance>;
	actions?: readonly ProcessActionSummaryLike[];
	resultImages?: {
		get(instanceId: string, turnRecordId: string, imageId: string): Promise<Uint8Array | null>;
	};
	processQuestions?: CoreServerSetupDeps["processQuestions"];
}) {
	const processEvents: Array<{
		instanceId: string;
		eventType: string;
		data: Record<string, unknown>;
	}> = [];
	const executeAction = vi.fn(async () => ({ ok: true as const, process: input.process }));
	const queueInputs = vi.fn(async () => ({ ok: true as const, process: input.process }));
	const retryProcess = vi.fn(async () => ({ ok: true as const, process: input.process }));
	const continueFailedTurn = vi.fn(async () => ({ ok: true as const, process: input.process }));
	const abortProcess = vi.fn(async () => ({ ok: true as const, process: input.process }));
	const deps = createTestServerSetupCapability({
		processes: {
			create: () => input.process,
			getById: (id) => (id === input.process.id ? input.process : null),
			listAll: () => [input.process],
		},
		events: {
			create: (event) => processEvents.push({ ...event, data: event.data ?? {} }),
			listByInstance: (instanceId) =>
				processEvents
					.filter((event) => event.instanceId === instanceId)
					.map((event, index) => ({
						id: `evt_${index}`,
						createdAt: "2026-01-01T00:00:00.000Z",
						...event,
					})),
		},
		commands: {
			startProcess: async () => ({ ok: true as const, process: input.process }),
			abortProcess,
			retryProcess,
			continueFailedTurn,
			queueInputs,
		},
		processActions: { listVisibleActions: () => input.actions ?? [], executeAction },
		...(input.resultImages ? { resultImages: input.resultImages } : {}),
		...(input.processQuestions ? { processQuestions: input.processQuestions } : {}),
	});
	return {
		deps,
		processEvents,
		executeAction,
		queueInputs,
		retryProcess,
		continueFailedTurn,
		abortProcess,
	};
}

function setupBridge(
	input: Parameters<typeof createDeps>[0],
	config: TelegramExtensionConfig = testConfig(),
) {
	const client = new FakeTelegramClient();
	const events = createEventBus();
	const deps = createDeps(input);
	const logger = { warn: vi.fn() };
	const bridge = new TelegramBridge({ config, deps: deps.deps, client, logger });
	bridge.register(events);
	return { client, events, bridge, logger, ...deps };
}

const defaultSelectionProfiles = [
	{
		id: "claude_fast",
		label: "Claude Fast",
		description: "fast",
		availability: "available" as const,
	},
	{
		id: "local_qwen",
		label: "Local Qwen",
		description: "local",
		availability: "available" as const,
	},
];

const defaultSelectionPreview: ProcessActionModelPreviewLike = {
	kind: "llm_turn",
	turnId: "implement",
	description: "Implement",
	resolvedModel: {
		status: "resolved",
		modelProfileId: "claude_fast",
		source: "catalog_default",
		error: null,
	},
};

function modelSelection(
	input: {
		profiles?: readonly ModelProfileOptionSummaryLike[] | null;
		result?: ProcessModelSelectionPreviewResultLike;
	} = {},
): ProcessModelSelectionServiceLike {
	return {
		listAvailableProfiles: () =>
			input.profiles === undefined ? defaultSelectionProfiles : input.profiles,
		preview: async () => input.result ?? defaultSelectionPreview,
	};
}

function testLauncher(): UiLauncherSummary {
	return {
		id: "test.launcher",
		processId: "test_process",
		displayName: "Test Process",
		label: "Test Launcher",
		description: "Launch a test process",
		card: {},
		launchConfigSchema: {
			id: "test_form",
			title: "Test Form",
			fields: [
				{
					id: "prompt",
					label: "Prompt",
					kind: "textarea",
					required: true,
					rememberRecentValues: true,
				},
				{
					id: "branch",
					label: "Branch",
					kind: "select",
					required: true,
					options: [{ value: "main", label: "Main" }],
				},
			],
		},
	};
}

function testModelSchema(): LauncherModelConfigSchemaLike {
	return {
		availableProfiles: [
			{ id: "claude_fast", label: "Claude Fast", description: "fast" },
			{ id: "local_qwen", label: "Local Qwen", description: "local" },
		],
		llmTurns: [
			{ turnId: "draft_plan", description: "Draft plan" },
			{ turnId: "implement", description: "Implement" },
		],
	};
}

function testModelPreview(): LauncherModelConfigPreviewLike {
	const schema = testModelSchema();
	const profile = schema.availableProfiles[0] ?? null;
	return {
		defaultModel: { source: "catalog_default", profile },
		turns: schema.llmTurns.map((turn) => ({
			...turn,
			effective: { source: "catalog_default", profile },
		})),
	};
}

function launchPlan(input: Record<string, unknown>): ProcessLaunchPlan {
	return {
		launcherId: "test.launcher",
		processId: "test_process",
		processInput: {
			processId: "test_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			title: null,
			externalId: null,
			externalUrl: null,
			metadata: { launcherInput: input },
			paramsJson: JSON.stringify(input),
			stateJson: "{}",
		},
		projectInputs: [],
		startTurnId: null,
	};
}

function setupLaunchBridge(
	options: {
		resolveUiLauncher?: ReturnType<typeof vi.fn>;
		recentValues?: Record<string, readonly string[]>;
		modelSchema?: LauncherModelConfigSchemaLike | null;
		modelPreview?: LauncherModelConfigPreviewLike | null;
		prepareLaunchPlan?: ReturnType<typeof vi.fn>;
	} = {},
) {
	const launchedProcess = createTestProcessInstance({ processId: "test_process" });
	const client = new FakeTelegramClient();
	const events = createEventBus();
	const launcher = testLauncher();
	const createProcessFromLaunchPlan = vi.fn(async () => ({
		ok: true as const,
		process: launchedProcess,
		projects: [],
	}));
	const resolveUiLauncher =
		options.resolveUiLauncher ??
		vi.fn(async (_launcherId: string, input: Record<string, unknown>) => ({
			ok: true as const,
			launcher: {
				launcherId: launcher.id,
				processId: launcher.processId,
				displayName: launcher.displayName,
				launchConfig: { processId: launcher.processId, params: input },
				launchPlan: launchPlan(input),
			},
		}));
	const recordRecentValues = vi.fn();
	const prepareLaunchPlan =
		options.prepareLaunchPlan ??
		vi.fn(
			async (plan: ProcessLaunchPlan, opts?: { modelConfig?: ProcessLaunchPlanModelConfig }) => ({
				ok: true as const,
				launchPlan: opts?.modelConfig
					? {
							...plan,
							processInput: {
								...plan.processInput,
								defaultModelProfileId: opts.modelConfig.defaultModelProfileId ?? null,
								turnConfigsJson: JSON.stringify(opts.modelConfig.turnConfigs ?? {}),
							},
						}
					: plan,
			}),
		);
	const deps = createTestServerSetupCapability({
		processes: {
			getById: (id) => (id === launchedProcess.id ? launchedProcess : null),
			listAll: () => [launchedProcess],
		},
		launcherService: {
			listUiLaunchers: () => [launcher],
			resolveUiDefaults: async () => ({ branch: "main" }),
			resolveUiOptions: async () => ({
				branch: [
					{ value: "main", label: "Main" },
					{ value: "develop", label: "Develop" },
				],
			}),
			resolveUiLauncher,
		},
		launcherRecentValues: {
			list: () => options.recentValues ?? {},
			record: recordRecentValues,
		},
		launcherModelConfigs: {
			getSchema: async () => options.modelSchema ?? null,
			preview: async () => options.modelPreview ?? null,
		},
		launchPlans: { prepare: prepareLaunchPlan },
		processLaunches: { createProcessFromLaunchPlan },
	});
	const bridge = new TelegramBridge({ config: testConfig(), deps, client });
	bridge.register(events);
	return {
		client,
		events,
		bridge,
		launcher,
		launchedProcess,
		createProcessFromLaunchPlan,
		resolveUiLauncher,
		prepareLaunchPlan,
		recordRecentValues,
	};
}

async function startProcessTopic(
	input: Parameters<typeof setupBridge>[0],
	config?: TelegramExtensionConfig,
) {
	const harness = setupBridge(input, config);
	await harness.bridge.start();
	harness.events.emit("process_created", {
		instanceId: input.process.id,
		process: input.process,
		projects: [],
	});
	await flushAsyncWork(5);
	return harness;
}

function topicThreadId(client: FakeTelegramClient): number {
	const id = client.createdTopics[0]?.messageThreadId;
	expect(id).toBeTypeOf("number");
	return id as number;
}

function allButtons(client: FakeTelegramClient) {
	return client.sentMessages.flatMap(
		(message) => message.replyMarkup?.inlineKeyboard?.flat() ?? [],
	);
}

function messagesWithButton(client: FakeTelegramClient, data: string) {
	return client.sentMessages.filter((message) =>
		message.replyMarkup?.inlineKeyboard?.flat().some((button) => button.callbackData === data),
	);
}

function findCallbackData(client: FakeTelegramClient, label: string): string | undefined {
	return allButtons(client).find((candidate) => candidate.text === label)?.callbackData;
}

function callbackData(client: FakeTelegramClient, label?: string): string {
	const button = label
		? allButtons(client).find((candidate) => candidate.text === label)
		: allButtons(client)[0];
	expect(button?.callbackData).toBeTruthy();
	return button?.callbackData as string;
}

function latestCallbackData(client: FakeTelegramClient, label: string): string {
	const button = allButtons(client)
		.filter((candidate) => candidate.text === label)
		.at(-1);
	expect(button?.callbackData).toBeTruthy();
	return button?.callbackData as string;
}

async function clickButton(
	client: FakeTelegramClient,
	data: string,
	overrides: Partial<Parameters<FakeTelegramClient["simulateCallback"]>[0]> = {},
): Promise<void> {
	await client.simulateCallback({
		id: "cb",
		chatId: "-100",
		messageThreadId: topicThreadId(client),
		from: { id: 123 },
		data,
		...overrides,
	});
}

async function sendText(
	client: FakeTelegramClient,
	text: string,
	overrides: Partial<Parameters<FakeTelegramClient["simulateText"]>[0]> = {},
): Promise<void> {
	await client.simulateText({
		messageId: 1,
		chatId: "-100",
		messageThreadId: topicThreadId(client),
		from: { id: 123 },
		text,
		...overrides,
	});
}

async function sendUnmappedTopicText(
	client: FakeTelegramClient,
	text: string,
	messageThreadId = 777,
	overrides: Partial<Parameters<FakeTelegramClient["simulateText"]>[0]> = {},
): Promise<void> {
	await client.simulateText({
		messageId: 1,
		chatId: "-100",
		messageThreadId,
		from: { id: 123 },
		text,
		...overrides,
	});
}

async function clickUnmappedTopicButton(
	client: FakeTelegramClient,
	label: string,
	messageThreadId = 777,
): Promise<void> {
	await clickUnmappedTopicData(client, callbackData(client, label), messageThreadId, `cb_${label}`);
}

async function clickUnmappedTopicData(
	client: FakeTelegramClient,
	data: string,
	messageThreadId = 777,
	id = "cb_unmapped",
): Promise<void> {
	await client.simulateCallback({
		id,
		chatId: "-100",
		messageThreadId,
		from: { id: 123 },
		data,
	});
}

async function clickLatestUnmappedTopicButton(client: FakeTelegramClient, label: string) {
	await clickUnmappedTopicData(client, latestCallbackData(client, label));
}

async function completeLaunchFormToReview(client: FakeTelegramClient) {
	await sendUnmappedTopicText(client, "/launch test.launcher");
	await sendUnmappedTopicText(client, "Implement the Telegram launcher");
	await clickUnmappedTopicButton(client, "Develop");
}

const approveAction = { id: "approve", label: "Approve", description: null };

async function setupActionModelSelection(
	input: {
		process?: ReturnType<typeof createTestProcessInstance>;
		selection?: ProcessModelSelectionServiceLike;
		config?: Partial<TelegramExtensionConfig>;
		actions?: readonly ProcessActionSummaryLike[];
	} = {},
) {
	const process = input.process ?? createTestProcessInstance({ lifecycleStatus: "waiting" });
	const harness = setupBridge(
		{ process, actions: input.actions ?? [approveAction] },
		testConfig({
			...input.config,
			actionModelSelection: {
				enabled: true,
				...(input.config?.actionModelSelection ?? {}),
			},
		}),
	);
	bridgeInternals(harness.bridge).processModelSelection = input.selection ?? modelSelection();
	await harness.bridge.start();
	harness.events.emit("process_created", {
		instanceId: process.id,
		process,
		projects: [],
	});
	await flushAsyncWork(5);
	return { ...harness, process };
}

const tailLogsAction = {
	id: "tail_logs",
	label: "Tail logs",
	description: null,
	form: {
		id: "tail_logs",
		title: "Tail logs",
		fields: [
			{
				id: "tailLines",
				label: "Lines",
				kind: "number" as const,
				placeholder: "120",
				description: "Optional number of log lines to return (1-2000).",
			},
		],
	},
	preview: { kind: "fixed_turn", turnId: "run_operation" },
};
const localShellRunCommandAction = {
	id: "run_command",
	label: "Run command",
	description: null,
	form: {
		id: "local_shell_run_command_form",
		title: "Run shell command",
		fields: [
			{
				id: "command",
				label: "Command",
				kind: "textarea" as const,
				required: true,
				placeholder: "pwd && ls -la",
				description: "Runs as bash -lc on the leitwerk server machine.",
			},
			{
				id: "cwd",
				label: "Working directory",
				kind: "text" as const,
				placeholder: "Use the current shell default",
				description: "Optional absolute or relative directory for this and later commands.",
			},
			{
				id: "timeoutSeconds",
				label: "Timeout seconds",
				kind: "number" as const,
				placeholder: "120",
				description: "Optional per-command timeout.",
			},
		],
	},
	preview: { kind: "fixed_turn", turnId: "execute_command" },
};
const piShellSendPromptAction = {
	id: "send_prompt",
	label: "Send prompt",
	description: null,
	form: {
		id: "pi_shell_prompt",
		title: "Send prompt",
		fields: [
			{
				id: "prompt",
				label: "Prompt",
				kind: "textarea" as const,
				required: true,
				description: "Instruction for the next Pi shell turn.",
			},
		],
	},
	preview: { kind: "fixed_turn", turnId: "run_prompt" },
};

function turnRecord(processId: string) {
	return {
		id: "trn_failed",
		instanceId: processId,
		turnId: "implement",
		turnType: "llm" as const,
		status: "failed" as const,
		attemptNumber: 1,
		parentTurnRecordId: null,
		pathType: "primary" as const,
		forkPiEntryId: null,
		resultPiEntryId: null,
		modelProfileId: null,
		turnResultMarkdown: null,
		errorSummary: "fallback",
		errorClass: "infrastructure" as const,
		startedAt: "2026-05-15T00:00:00.000Z",
		endedAt: "2026-05-15T00:01:00.000Z",
	};
}

function leafOutcomeSnapshot(processId: string, fallbackMarkdown = "unique-result-token") {
	return {
		id: "leaf_1",
		instanceId: processId,
		leafEntryId: "assistant-result",
		turnRecordId: "trn_result",
		rendererId: "test:result",
		schemaVersion: 1,
		props: {},
		fallbackMarkdown,
		status: "ready" as const,
		warningCode: null,
		warningMessage: null,
		anchoredAt: "2026-05-15T00:01:00.000Z",
		createdAt: "2026-05-15T00:01:00.000Z",
	};
}

describe("TelegramBridge", () => {
	it("shows launch help when an allowlisted user creates a new unmapped topic", async () => {
		const { bridge, client } = setupLaunchBridge();
		await bridge.start();

		await client.simulateForumTopicCreated({
			messageId: 1,
			chatId: "-100",
			messageThreadId: 777,
			from: { id: 123 },
		});

		expect(client.sentMessages).toContainEqual(
			expect.objectContaining({ chatId: "-100", messageThreadId: 777 }),
		);
	});

	it("lists launchers and starts a launch wizard in an unmapped topic", async () => {
		const { bridge, client } = setupLaunchBridge();
		await bridge.start();

		await sendUnmappedTopicText(client, "/launch");
		await clickUnmappedTopicButton(client, "Test Launcher");

		expect(
			client.sentMessages.some((message) => message.text.includes("Available launchers")),
		).toBe(true);
		expect(client.sentMessages.at(-1)?.replyMarkup?.forceReply).toBe(true);
	});

	it("launches a process from an unmapped topic and claims that topic for the process", async () => {
		const { bridge, client, createProcessFromLaunchPlan, recordRecentValues } = setupLaunchBridge();
		await bridge.start();

		await completeLaunchFormToReview(client);
		expect(findCallbackData(client, "Change models")).toBeUndefined();
		await clickUnmappedTopicButton(client, "Start process");

		expect(createProcessFromLaunchPlan).toHaveBeenCalledOnce();
		expect(createProcessFromLaunchPlan).toHaveBeenCalledWith(expect.any(Object), {
			actor: TELEGRAM_ACTOR,
		});
		expect(recordRecentValues).toHaveBeenCalledWith("test.launcher", expect.any(Object));
		const submittedPlan = createProcessFromLaunchPlan.mock.calls[0]?.[0] as ProcessLaunchPlan;
		expect(submittedPlan.processInput.metadata).toMatchObject({
			telegram: {
				launchThread: {
					mode: "forum_topic",
					chatId: "-100",
					messageThreadId: 777,
				},
			},
		});
	});

	it("allows Telegram launchers to change default and per-turn models", async () => {
		const { bridge, client, createProcessFromLaunchPlan, prepareLaunchPlan } = setupLaunchBridge({
			modelSchema: testModelSchema(),
			modelPreview: testModelPreview(),
		});
		await bridge.start();

		await completeLaunchFormToReview(client);
		expect(client.sentMessages.at(-1)?.text).toContain("Model setup");
		await clickUnmappedTopicButton(client, "Change models");
		expect(client.sentMessages.at(-1)?.text).toContain("Default model");
		await clickLatestUnmappedTopicButton(client, "local_qwen");
		expect(client.sentMessages.at(-1)?.text).toContain("Draft plan");
		await clickLatestUnmappedTopicButton(client, "claude_fast");
		await sendUnmappedTopicText(client, "/skip");
		await clickUnmappedTopicButton(client, "Start process");

		expect(createProcessFromLaunchPlan).toHaveBeenCalledOnce();
		expect(prepareLaunchPlan).toHaveBeenLastCalledWith(
			expect.any(Object),
			expect.objectContaining({
				replaceModelConfig: true,
				modelConfig: {
					defaultModelProfileId: "local_qwen",
					turnConfigs: { draft_plan: { modelProfileId: "claude_fast" } },
				},
			}),
		);
		const submittedPlan = createProcessFromLaunchPlan.mock.calls[0]?.[0] as ProcessLaunchPlan;
		expect(submittedPlan.processInput.defaultModelProfileId).toBe("local_qwen");
		expect(submittedPlan.processInput.turnConfigsJson).toBe(
			JSON.stringify({ draft_plan: { modelProfileId: "claude_fast" } }),
		);
	});

	it("keeps Telegram model edit open when a typed model profile is invalid", async () => {
		const { bridge, client, createProcessFromLaunchPlan } = setupLaunchBridge({
			modelSchema: testModelSchema(),
			modelPreview: testModelPreview(),
		});
		await bridge.start();

		await completeLaunchFormToReview(client);
		await clickUnmappedTopicButton(client, "Change models");
		await sendUnmappedTopicText(client, "missing_model");

		expect(createProcessFromLaunchPlan).not.toHaveBeenCalled();
		expect(client.sentMessages.at(-1)?.text).toContain("must match an available model profile");
		expect(client.sentMessages.at(-1)?.replyMarkup).toBeTruthy();
	});

	it("offers launcher recent values as field buttons", async () => {
		const { bridge, client, createProcessFromLaunchPlan } = setupLaunchBridge({
			recentValues: { prompt: ["Use remembered prompt"] },
		});
		await bridge.start();

		await sendUnmappedTopicText(client, "/launch test.launcher");
		await clickUnmappedTopicButton(client, "Use remembered prompt");
		await clickUnmappedTopicButton(client, "Develop");
		await clickUnmappedTopicButton(client, "Start process");

		expect(createProcessFromLaunchPlan).toHaveBeenCalledOnce();
		const submittedPlan = createProcessFromLaunchPlan.mock.calls[0]?.[0] as ProcessLaunchPlan;
		expect(submittedPlan.processInput.paramsJson).toContain("Use remembered prompt");
	});

	it("keeps a launch draft open when launcher validation rejects a field", async () => {
		const resolveUiLauncher = vi.fn(async () => ({
			ok: false as const,
			errors: [{ code: "invalid", message: "Prompt is required", fieldId: "prompt" }],
		}));
		const { bridge, client, createProcessFromLaunchPlan } = setupLaunchBridge({
			resolveUiLauncher,
		});
		await bridge.start();

		await sendUnmappedTopicText(client, "/launch test.launcher");
		await sendUnmappedTopicText(client, "bad prompt");
		await clickUnmappedTopicButton(client, "Develop");

		expect(createProcessFromLaunchPlan).not.toHaveBeenCalled();
		expect(client.sentMessages.at(-1)?.replyMarkup).toBeTruthy();
	});

	it("reuses and renames a claimed launch topic when process_created is emitted", async () => {
		const { bridge, client, events, launchedProcess } = setupLaunchBridge();
		launchedProcess.metadata = {
			telegram: {
				launchThread: { mode: "forum_topic", chatId: "-100", messageThreadId: 777 },
			},
		};
		await bridge.start();

		events.emit("process_created", {
			instanceId: launchedProcess.id,
			process: launchedProcess,
			projects: [],
		});
		await flushAsyncWork(5);

		expect(client.createdTopics).toHaveLength(0);
		expect(client.editedTopics).toEqual([
			expect.objectContaining({ chatId: "-100", messageThreadId: 777 }),
		]);
		expect(client.sentMessages.some((message) => message.messageThreadId === 777)).toBe(true);
	});

	it("does not allow non-allowlisted users to launch processes", async () => {
		const { bridge, client, createProcessFromLaunchPlan } = setupLaunchBridge();
		await bridge.start();

		await sendUnmappedTopicText(client, "/launch test.launcher", 777, { from: { id: 999 } });

		expect(createProcessFromLaunchPlan).not.toHaveBeenCalled();
		expect(client.sentMessages).toHaveLength(0);
	});

	it("creates a topic and records the durable thread mapping", async () => {
		const process = createTestProcessInstance({ title: "Implement thing" });
		const { client, processEvents } = await startProcessTopic({ process });

		expect(client.createdTopics).toHaveLength(1);
		expect(processEvents.some((event) => event.eventType === "telegram.thread_linked")).toBe(true);
		expect(
			client.sentMessages.some(
				(message) => message.chatId === "-100" && message.parseMode === "HTML",
			),
		).toBe(true);
	});

	it("delivers active-turn questions and submits Telegram answers", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const request = createTestQuestionRequest({
			instanceId: process.id,
			questions: [
				createTestQuestion({
					options: [
						{
							id: "question_1_option_1",
							label: "Safe (recommended)",
							details: "Small change",
						},
						{ id: "question_1_option_2", label: "Bold", details: null },
					],
				}),
			],
		});
		const submitAnswers = vi.fn(
			async (_instanceId: string, _requestId: string, _draft: readonly QuestionAnswerDraft[]) => ({
				ok: true as const,
				request: {
					...request,
					status: "answered" as const,
					answers: ["Safe (recommended)"],
				},
			}),
		);
		const { client, events } = await startProcessTopic({
			process,
			processQuestions: { listOpen: () => [], submitAnswers },
		});

		events.emit("question_requested", { instanceId: process.id, request });
		await flushAsyncWork(5);
		expect(client.sentMessages.at(-1)?.text).toContain("Choose a strategy");
		expect(client.sentMessages.at(-1)?.text).toContain("Safe (recommended)");

		await sendText(client, "Use the safe strategy");
		await flushAsyncWork(5);

		expect(submitAnswers).toHaveBeenCalledWith(
			process.id,
			request.id,
			[expect.objectContaining({ freeText: "Use the safe strategy" })],
			TELEGRAM_ACTOR,
		);
		expect(client.sentMessages.at(-1)?.text).toContain("Answers sent");
	});

	it("renames the process topic when a generated title is applied", async () => {
		const process = createTestProcessInstance({ title: null });
		const { client, events } = await startProcessTopic({ process });
		process.title = "Generated title";

		events.emit("process_updated", {
			instanceId: process.id,
			process,
			changedFields: ["title"],
		});
		await flushAsyncWork(5);

		expect(client.editedTopics).toEqual([
			expect.objectContaining({ messageThreadId: topicThreadId(client), name: expect.any(String) }),
		]);
	});

	it("retries topic creation on later events after an initial create failure", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { bridge, events, client, processEvents } = setupBridge({ process });
		client.failNextCreateForumTopic(new Error("missing forum permission"));
		await bridge.start();
		events.emit("process_created", { instanceId: process.id, process, projects: [] });
		await flushAsyncWork(5);

		expect(client.createdTopics).toHaveLength(0);

		events.emit("process_updated", {
			instanceId: process.id,
			process,
			changedFields: ["selectedTurnId"],
		});
		await flushAsyncWork(5);

		expect(client.createdTopics).toHaveLength(1);
		expect(processEvents.some((event) => event.eventType === "telegram.thread_linked")).toBe(true);
	});

	it("queues free text in a process topic to the mapped process", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { client, queueInputs } = await startProcessTopic({ process });

		await sendText(client, "Please adjust the plan");

		expect(queueInputs).toHaveBeenCalledWith(
			process.id,
			[
				expect.objectContaining({
					source: "external_comment",
					bodyMarkdown: "Please adjust the plan",
				}),
			],
			expect.objectContaining({ actor: TELEGRAM_ACTOR }),
		);
	});

	it("executes selected actions and rejects callbacks replayed from another topic", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			selectedTurnId: "review",
		});
		const { client, executeAction } = await startProcessTopic({
			process,
			actions: [approveAction],
		});
		const data = callbackData(client);
		expect(data).toBe(`a:${process.id}:approve`);

		await clickButton(client, data);
		expect(executeAction).toHaveBeenCalledWith(
			process.id,
			"approve",
			{},
			{ source: "ui", origin: "external_interface", actor: TELEGRAM_ACTOR },
		);

		executeAction.mockClear();
		await clickButton(client, data, {
			id: "missing_thread_id",
			messageThreadId: undefined,
		});
		expect(executeAction).not.toHaveBeenCalled();
		expect(client.answeredCallbacks.at(-1)).toMatchObject({ showAlert: true });

		executeAction.mockClear();
		await clickButton(client, "action:approve", { id: "legacy_action" });
		expect(executeAction).not.toHaveBeenCalled();
		expect(client.answeredCallbacks.at(-1)).toMatchObject({ showAlert: true });

		executeAction.mockClear();
		await clickButton(client, data, {
			id: "wrong_thread",
			messageThreadId: topicThreadId(client) + 1,
		});
		expect(executeAction).not.toHaveBeenCalled();
		expect(client.answeredCallbacks.at(-1)).toMatchObject({ showAlert: true });
	});

	it("announces submitted form actions with entered values and expected next turn", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			selectedTurnId: "control_panel",
		});
		const { client, executeAction } = await startProcessTopic({
			process,
			actions: [tailLogsAction],
		});

		await clickButton(client, callbackData(client, "Tail logs"));
		expect(client.sentMessages.at(-1)?.text).toContain("120");

		await sendText(client, "50");

		expect(executeAction).toHaveBeenCalledWith(
			process.id,
			"tail_logs",
			{ tailLines: 50 },
			{ source: "ui", origin: "external_interface", actor: TELEGRAM_ACTOR },
		);
		const confirmation = client.sentMessages.at(-1)?.text ?? "";
		expect(confirmation).toContain("Tail logs");
		expect(confirmation).toContain("Lines");
		expect(confirmation).toContain("50");
		expect(confirmation).toContain("run_operation");
	});

	it("shows current action labels in status", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			selectedTurnId: "control_panel",
		});
		const { client } = await startProcessTopic({ process, actions: [tailLogsAction] });

		await sendText(client, "/status");

		expect(client.sentMessages.at(-1)?.text).toContain("Tail logs");
		expect(client.sentMessages.at(-1)?.text).toContain("Control Panel");
	});

	it("supports local-shell command forms with skipped optional fields and command output", async () => {
		const process = createTestProcessInstance({
			processId: "local_shell_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "command_console",
		});
		const { client, executeAction, events } = await startProcessTopic({
			process,
			actions: [localShellRunCommandAction],
		});
		const latestSkipData = () => {
			const data = allButtons(client)
				.filter((button) => button.text === "Skip")
				.at(-1)?.callbackData;
			expect(data).toBeTruthy();
			return data as string;
		};

		await clickButton(client, callbackData(client, "Run command"));
		await sendText(client, "printf LOCAL_SHELL_TOKEN");
		await clickButton(client, latestSkipData());
		await clickButton(client, latestSkipData());

		expect(executeAction).toHaveBeenCalledWith(
			process.id,
			"run_command",
			{ command: "printf LOCAL_SHELL_TOKEN" },
			{ source: "ui", origin: "external_interface", actor: TELEGRAM_ACTOR },
		);
		expect(client.sentMessages.at(-1)?.text).toContain("execute_command");

		process.lifecycleStatus = "waiting";
		process.selectedTurnId = "command_console";
		events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_local_shell",
			turnId: "execute_command",
			outcome: "command_finished",
			params: {},
			turnResultMarkdown: "## Command result\n\nLOCAL_SHELL_TOKEN",
		});
		await flushAsyncWork(5);

		expect(client.sentMessages.some((message) => message.text.includes("LOCAL_SHELL_TOKEN"))).toBe(
			true,
		);
	});

	it("supports pi-shell prompt actions and assistant-output results", async () => {
		const process = createTestProcessInstance({
			processId: "pi_shell_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "prompt_console",
		});
		const { client, executeAction, events } = await startProcessTopic({
			process,
			actions: [piShellSendPromptAction],
		});

		await clickButton(client, callbackData(client, "Send prompt"));
		await sendText(client, "Inspect the primary status");

		expect(executeAction).toHaveBeenCalledWith(
			process.id,
			"send_prompt",
			{ prompt: "Inspect the primary status" },
			{ source: "ui", origin: "external_interface", actor: TELEGRAM_ACTOR },
		);
		expect(client.sentMessages.at(-1)?.text).toContain("run_prompt");

		process.lifecycleStatus = "waiting";
		process.selectedTurnId = "prompt_console";
		events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_pi_shell",
			turnId: "run_prompt",
			outcome: "responded",
			params: {},
			turnResultMarkdown: "## Pi answer\n\nPI_SHELL_RESULT_TOKEN",
		});
		await flushAsyncWork(5);

		expect(
			client.sentMessages.some((message) => message.text.includes("PI_SHELL_RESULT_TOKEN")),
		).toBe(true);
	});

	it("collects action form input and escapes form prompts before executing", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			selectedTurnId: "review",
		});
		const { client, executeAction } = await startProcessTopic({
			process,
			actions: [
				{
					id: "request_changes",
					label: "Request changes",
					description: null,
					form: {
						id: "request_changes",
						title: "Request changes",
						fields: [
							{
								id: "message",
								label: "<b>Message</b>",
								kind: "textarea",
								required: true,
								description: "Use <unsafe> markup",
							},
						],
					},
				},
			],
		});

		await clickButton(client, callbackData(client));
		expect(client.sentMessages.at(-1)?.text).toContain("&lt;b&gt;Message&lt;/b&gt;");
		expect(client.sentMessages.at(-1)?.text).toContain("&lt;unsafe&gt;");

		await sendText(client, "Please revise tests");
		expect(executeAction).toHaveBeenCalledWith(
			process.id,
			"request_changes",
			{ message: "Please revise tests" },
			{ source: "ui", origin: "external_interface", actor: TELEGRAM_ACTOR },
		);
	});

	it("skips optional action fields without submitting empty values", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			selectedTurnId: "review",
		});
		const { client, executeAction } = await startProcessTopic({
			process,
			actions: [
				{
					id: "accept_review",
					label: "Accept review",
					description: null,
					form: {
						id: "accept_review",
						title: "Accept review",
						fields: [{ id: "message", label: "Message", kind: "textarea" }],
					},
				},
			],
		});

		await clickButton(client, callbackData(client));
		expect(allButtons(client).map((button) => button.text)).toContain("Skip");

		await clickButton(client, callbackData(client, "Skip"));
		expect(executeAction).toHaveBeenCalledWith(
			process.id,
			"accept_review",
			{},
			{ source: "ui", origin: "external_interface", actor: TELEGRAM_ACTOR },
		);
	});

	it("does not apply stale action form skip buttons to a newer form", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			selectedTurnId: "review",
		});
		const { client, executeAction } = await startProcessTopic({
			process,
			actions: [
				{
					id: "accept_review",
					label: "Accept review",
					description: null,
					form: {
						id: "accept_review",
						title: "Accept review",
						fields: [{ id: "message", label: "Message", kind: "textarea" }],
					},
				},
				{
					id: "dismiss_review",
					label: "Dismiss review",
					description: null,
					form: {
						id: "dismiss_review",
						title: "Dismiss review",
						fields: [{ id: "message", label: "Message", kind: "textarea" }],
					},
				},
			],
		});

		await clickButton(client, callbackData(client, "Accept review"));
		const staleSkipData = callbackData(client, "Skip");
		await clickButton(client, callbackData(client, "Dismiss review"));

		await clickButton(client, staleSkipData);

		expect(executeAction).not.toHaveBeenCalled();
		expect(client.sentMessages.at(-1)?.text).toContain("skip button is stale");
	});

	it("does not execute stale action callbacks after the process leaves waiting", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			selectedTurnId: "review",
		});
		const { client, executeAction } = await startProcessTopic({
			process,
			actions: [approveAction],
		});
		const data = callbackData(client);
		process.lifecycleStatus = "active";

		await clickButton(client, data);

		expect(executeAction).not.toHaveBeenCalled();
	});

	it("renders turn failure summaries from generic server events", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "error" });
		const { events, client } = await startProcessTopic({ process });

		events.emit("turn_failed", {
			instanceId: process.id,
			errorSummary: "Bad <failure> & details",
			errorClass: "infrastructure",
			turnRecord: turnRecord(process.id),
		});
		await flushAsyncWork(5);

		const failureMessage = client.sentMessages.find((message) =>
			message.text.includes("Bad &lt;failure&gt; &amp; details"),
		);
		expect(failureMessage?.text).toContain("infrastructure");
	});

	it("places available actions after a result when the process returns to waiting", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { events, client } = await startProcessTopic({ process, actions: [approveAction] });
		process.lifecycleStatus = "waiting";
		process.selectedTurnId = "review";

		events.emit("leaf_outcome_captured", {
			instanceId: process.id,
			snapshot: leafOutcomeSnapshot(process.id),
		});
		events.emit("process_updated", {
			instanceId: process.id,
			process,
			changedFields: ["lifecycleStatus", "selectedTurnId"],
		});
		await flushAsyncWork(5);

		const actionIndex = client.sentMessages.findIndex((message) =>
			message.replyMarkup?.inlineKeyboard
				.flat()
				.some((button) => button.callbackData === `a:${process.id}:approve`),
		);
		const resultIndex = client.sentMessages.findIndex((message) =>
			message.text.includes("unique-result-token"),
		);
		expect(actionIndex).toBeGreaterThanOrEqual(0);
		expect(resultIndex).toBeGreaterThanOrEqual(0);
		expect(resultIndex).toBeLessThan(actionIndex);
	});

	it("sends turn outcome markdown before the next action prompt", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { events, client } = await startProcessTopic({ process, actions: [tailLogsAction] });
		process.lifecycleStatus = "waiting";
		process.selectedTurnId = "control_panel";
		process.currentExecution = null;

		events.emit("process_updated", {
			instanceId: process.id,
			process,
			changedFields: ["currentExecution", "lifecycleStatus", "selectedTurnId"],
		});
		events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_operation",
			turnId: "run_operation",
			outcome: "operation_finished",
			params: {},
			turnResultMarkdown: "## Primary log tail\n\nLOG_TOKEN",
		});
		await flushAsyncWork(5);

		const resultIndex = client.sentMessages.findIndex((message) =>
			message.text.includes("LOG_TOKEN"),
		);
		const actionIndex = client.sentMessages.findIndex((message) =>
			message.replyMarkup?.inlineKeyboard
				.flat()
				.some((button) => button.callbackData === `a:${process.id}:tail_logs`),
		);
		expect(resultIndex).toBeGreaterThanOrEqual(0);
		expect(actionIndex).toBeGreaterThanOrEqual(0);
		expect(resultIndex).toBeLessThan(actionIndex);
	});

	it("uploads correlated result images and rendered Mermaid diagrams", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const getResultImage = vi.fn(async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
		const { events, client } = await startProcessTopic({
			process,
			resultImages: { get: getResultImage },
		});
		const operationCount = client.operations.length;

		events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_visual",
			turnId: "review",
			outcome: "done",
			params: {},
			turnResultMarkdown: [
				"Visual evidence follows.",
				`![Screenshot](/api/processes/${process.id}/turn-records/trn_visual/result-images/img_evidence.png)`,
				"The screenshot confirms the result.",
				"```mermaid\nflowchart LR\n  A --> B\n```",
			].join("\n\n"),
		});
		await vi.waitFor(() => expect(client.sentPhotos).toHaveLength(2), { timeout: 10_000 });

		expect(getResultImage).toHaveBeenCalledWith(process.id, "trn_visual", "img_evidence.png");
		expect(client.sentPhotos[0]).toMatchObject({
			filename: "img_evidence.png",
			caption: "Screenshot",
		});
		expect(client.sentPhotos[1]?.filename).toBe("diagram-3.png");
		expect([...(client.sentPhotos[1]?.bytes.slice(0, 4) ?? [])]).toEqual([137, 80, 78, 71]);
		expect(client.sentMessages.some((message) => message.text.includes("flowchart LR"))).toBe(
			false,
		);
		const resultOperations = client.operations.slice(operationCount);
		expect(resultOperations.map((operation) => operation.kind)).toEqual([
			"sendMessage",
			"sendPhoto",
			"sendMessage",
			"sendPhoto",
		]);
		expect(resultOperations[0]).toMatchObject({
			kind: "sendMessage",
			input: { text: expect.stringContaining("Visual evidence follows") },
		});
		expect(resultOperations[2]).toMatchObject({
			kind: "sendMessage",
			input: { text: expect.stringContaining("The screenshot confirms the result") },
		});
	});

	it("retries a Telegram-rejected photo as a document", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { events, client } = await startProcessTopic({
			process,
			resultImages: {
				get: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
			},
		});
		client.failNextSendPhoto(new Error("Telegram rejected photo size or format"));

		events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_photo_fallback",
			turnId: "review",
			outcome: "done",
			params: {},
			turnResultMarkdown: `![Large](/api/processes/${process.id}/turn-records/trn_photo_fallback/result-images/img_large.png)`,
		});
		await vi.waitFor(() => expect(client.sentDocuments).toHaveLength(1));

		expect(client.sentPhotos).toHaveLength(0);
		expect(client.sentDocuments[0]).toMatchObject({ filename: "img_large.png", caption: "Large" });
	});

	it("posts terminal turn outcome markdown before closing a completed process topic", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { events, client } = await startProcessTopic({ process });
		process.lifecycleStatus = "completed";
		process.selectedTurnId = null;
		process.currentExecution = null;

		events.emit("process_updated", {
			instanceId: process.id,
			process,
			changedFields: ["currentExecution", "lifecycleStatus", "selectedTurnId"],
		});
		events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_terminal_result",
			turnId: "finish",
			outcome: "done",
			params: {},
			turnResultMarkdown: "TERMINAL_RESULT_TOKEN",
		});
		await flushAsyncWork(5);

		const resultOperationIndex = client.operations.findIndex(
			(operation) =>
				operation.kind === "sendMessage" && operation.input.text.includes("TERMINAL_RESULT_TOKEN"),
		);
		const closeOperationIndex = client.operations.findIndex(
			(operation) => operation.kind === "closeForumTopic",
		);
		expect(resultOperationIndex).toBeGreaterThanOrEqual(0);
		expect(closeOperationIndex).toBeGreaterThanOrEqual(0);
		expect(resultOperationIndex).toBeLessThan(closeOperationIndex);
	});

	it("does not duplicate a leaf result when the matching turn outcome is also emitted", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { events, client } = await startProcessTopic({ process, actions: [approveAction] });
		process.lifecycleStatus = "waiting";
		process.selectedTurnId = "review";
		process.currentExecution = null;

		events.emit("leaf_outcome_captured", {
			instanceId: process.id,
			snapshot: leafOutcomeSnapshot(process.id, "DEDUP_RESULT_TOKEN"),
		});
		events.emit("process_updated", {
			instanceId: process.id,
			process,
			changedFields: ["currentExecution", "lifecycleStatus", "selectedTurnId"],
		});
		events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_result",
			turnId: "implement",
			outcome: "done",
			params: {},
			turnResultMarkdown: "DEDUP_RESULT_TOKEN",
		});
		await flushAsyncWork(5);

		expect(
			client.sentMessages.filter((message) => message.text.includes("DEDUP_RESULT_TOKEN")),
		).toHaveLength(1);
		expect(messagesWithButton(client, `a:${process.id}:approve`).length).toBeGreaterThan(0);
	});

	it("does not let an empty leaf fallback suppress later turn outcome markdown", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { events, client } = await startProcessTopic({ process });

		events.emit("leaf_outcome_captured", {
			instanceId: process.id,
			snapshot: leafOutcomeSnapshot(process.id, "   "),
		});
		events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_result",
			turnId: "implement",
			outcome: "done",
			params: {},
			turnResultMarkdown: "TURN_OUTCOME_AFTER_EMPTY_LEAF",
		});
		await flushAsyncWork(5);

		expect(
			client.sentMessages.some((message) => message.text.includes("TURN_OUTCOME_AFTER_EMPTY_LEAF")),
		).toBe(true);
	});

	it("splits long turn outcomes across Telegram messages", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const config = testConfig({ markdown: { maxChars: 80 } });
		const { events, client } = await startProcessTopic({ process }, config);
		const messageCount = client.sentMessages.length;

		events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_long_result",
			turnId: "run_operation",
			outcome: "operation_finished",
			params: {},
			turnResultMarkdown: "long-turn-result-token ".repeat(30),
		});
		await flushAsyncWork(5);

		const resultMessages = client.sentMessages.slice(messageCount);
		const combined = resultMessages.map((message) => message.text).join("");
		expect(resultMessages.length).toBeGreaterThan(1);
		expect(resultMessages.every((message) => message.text.length <= 80)).toBe(true);
		expect(combined).toContain("long-turn-result-token");
		expect(combined).not.toContain("…");
	});

	it("splits long leaf outcomes across Telegram messages", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const config = testConfig({ markdown: { maxChars: 80 } });
		const { events, client } = await startProcessTopic({ process }, config);
		const messageCount = client.sentMessages.length;

		events.emit("leaf_outcome_captured", {
			instanceId: process.id,
			snapshot: leafOutcomeSnapshot(process.id, "long-result-token ".repeat(30)),
		});
		await flushAsyncWork(5);

		const resultMessages = client.sentMessages.slice(messageCount);
		const combined = resultMessages.map((message) => message.text).join("");
		expect(resultMessages.length).toBeGreaterThan(1);
		expect(resultMessages.every((message) => message.text.length <= 80)).toBe(true);
		expect(combined).toContain("long-result-token");
		expect(combined).not.toContain("…");
	});

	it("falls back only the failed HTML chunk when split delivery fails", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const config = testConfig({ markdown: { maxChars: 80 } });
		const { events, client } = await startProcessTopic({ process }, config);
		const messageCount = client.sentMessages.length;
		client.failSendMessageAfter(1);

		events.emit("leaf_outcome_captured", {
			instanceId: process.id,
			snapshot: leafOutcomeSnapshot(
				process.id,
				`FIRST-UNIQUE ${"alpha ".repeat(20)} SECOND-UNIQUE ${"omega ".repeat(20)}`,
			),
		});
		await flushAsyncWork(5);

		const resultMessages = client.sentMessages.slice(messageCount);
		expect(resultMessages.length).toBeGreaterThan(2);
		expect(resultMessages.filter((message) => message.text.includes("FIRST-UNIQUE"))).toHaveLength(
			1,
		);
		expect(resultMessages.some((message) => message.text.includes("SECOND-UNIQUE"))).toBe(true);
	});

	it("keeps reply markup on the final chunk of a split prompt", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			title: "Very long process title ".repeat(10),
		});
		const config = testConfig({ markdown: { maxChars: 80 } });
		const { client } = await startProcessTopic({ process, actions: [approveAction] }, config);

		const prompt = messagesWithButton(client, `a:${process.id}:approve`).at(-1);
		expect(prompt).toBe(client.sentMessages.at(-1));
		expect(prompt?.text.length).toBeLessThanOrEqual(80);
		expect(client.sentMessages.at(-2)?.replyMarkup).toBeUndefined();
	});

	it("sends action prompts for repeated waiting turns with the same action ids", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { events, client } = await startProcessTopic({ process, actions: [approveAction] });
		const countActionPrompts = () => messagesWithButton(client, `a:${process.id}:approve`).length;

		process.lifecycleStatus = "waiting";
		process.selectedTurnId = "review";
		events.emit("process_updated", {
			instanceId: process.id,
			process: { ...process },
			changedFields: ["lifecycleStatus", "selectedTurnId"],
		});
		await flushAsyncWork(5);
		expect(countActionPrompts()).toBe(1);

		process.lifecycleStatus = "active";
		events.emit("process_updated", {
			instanceId: process.id,
			process: { ...process },
			changedFields: ["lifecycleStatus"],
		});
		process.lifecycleStatus = "waiting";
		events.emit("process_updated", {
			instanceId: process.id,
			process: { ...process },
			changedFields: ["lifecycleStatus"],
		});
		await flushAsyncWork(5);

		expect(countActionPrompts()).toBe(2);
	});

	it.each([
		"completed",
		"aborted",
	] as const)("closes the process topic when the process becomes %s", async (lifecycleStatus) => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { events, client } = await startProcessTopic({ process });
		process.lifecycleStatus = lifecycleStatus;

		events.emit("process_updated", {
			instanceId: process.id,
			process,
			changedFields: ["lifecycleStatus"],
		});
		await flushAsyncWork(5);

		expect(client.closedTopics).toEqual([
			{ chatId: "-100", messageThreadId: topicThreadId(client) },
		]);
	});

	it("closes the process topic when a terminal process is first bridged", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "completed" });
		const { client } = await startProcessTopic({ process });

		expect(client.closedTopics).toEqual([
			{ chatId: "-100", messageThreadId: topicThreadId(client) },
		]);
	});

	it("omits abort buttons and aborts when the process topic is closed", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			selectedTurnId: "review",
		});
		const { client, abortProcess } = await startProcessTopic({
			process,
			actions: [approveAction],
		});

		expect(allButtons(client).map((button) => button.text)).not.toContain("Abort");

		await client.simulateForumTopicClosed({
			messageId: 99,
			chatId: "-100",
			messageThreadId: topicThreadId(client),
			from: null,
		});
		await flushAsyncWork(5);

		expect(abortProcess).toHaveBeenCalledWith(process.id, { actor: TELEGRAM_ACTOR });
	});

	it("does not queue unknown slash commands as process input", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { client, queueInputs } = await startProcessTopic({ process });
		const messageCount = client.sentMessages.length;

		await sendText(client, "/action");

		expect(queueInputs).not.toHaveBeenCalled();
		expect(client.sentMessages.length).toBeGreaterThan(messageCount);
	});

	it("does not treat /repeat as a recognized command in process topics", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "waiting" });
		const { client, queueInputs } = await startProcessTopic({
			process,
			actions: [approveAction],
		});

		await sendText(client, "/repeat");

		expect(queueInputs).not.toHaveBeenCalled();
		// /repeat is not a recognized command, so an unknown-command message is sent
		expect(client.sentMessages.at(-1)?.text).toContain("Unknown command");
	});

	it("treats /repeat as text input during a pending action form prompt", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "waiting",
			selectedTurnId: "review",
		});
		const { client, executeAction } = await startProcessTopic({
			process,
			actions: [
				{
					id: "request_changes",
					label: "Request changes",
					description: null,
					form: {
						id: "request_changes",
						title: "Request changes",
						fields: [
							{
								id: "message",
								label: "Message",
								kind: "textarea",
								required: true,
							},
						],
					},
				},
			],
		});

		await clickButton(client, callbackData(client));
		await sendText(client, "/repeat");

		// /repeat is now treated as regular text and submitted as the message
		expect(executeAction).toHaveBeenCalledWith(
			process.id,
			"request_changes",
			{ message: "/repeat" },
			expect.objectContaining({ source: "ui", origin: "external_interface" }),
		);
	});

	it("runs generic recovery commands from error-process buttons", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "error",
			currentExecution: { kind: "server_turn", id: "trn_failed" },
			metadata: buildFailedTurnRecoveryMetadata("trn_failed"),
		});
		const { client, retryProcess, continueFailedTurn } = await startProcessTopic({ process });

		await clickButton(client, callbackData(client, "Retry"));
		expect(retryProcess).toHaveBeenCalledWith(process.id, { actor: TELEGRAM_ACTOR });

		await clickButton(client, callbackData(client, "Continue"));
		await sendText(client, "/skip");
		expect(continueFailedTurn).toHaveBeenCalledWith(process.id, "trn_failed", {
			prompt: null,
			actor: TELEGRAM_ACTOR,
		});
	});

	it("does not offer unusable recovery buttons without matching recovery state", async () => {
		const orphanErrorProcess = createTestProcessInstance({
			lifecycleStatus: "error",
			currentExecution: null,
		});
		const orphan = await startProcessTopic({ process: orphanErrorProcess });
		expect(findCallbackData(orphan.client, "Retry")).toBeUndefined();
		expect(findCallbackData(orphan.client, "Continue")).toBeUndefined();

		const failedAutomaticProcess = createTestProcessInstance({
			lifecycleStatus: "error",
			currentExecution: { kind: "server_turn", id: "trn_failed_automatic" },
		});
		const failedAutomatic = await startProcessTopic({ process: failedAutomaticProcess });
		expect(findCallbackData(failedAutomatic.client, "Retry")).toBeTruthy();
		expect(findCallbackData(failedAutomatic.client, "Continue")).toBeUndefined();

		const messagesBeforeStaleContinue = failedAutomatic.client.sentMessages.length;
		await clickButton(failedAutomatic.client, `c:${failedAutomaticProcess.id}`);
		expect(failedAutomatic.continueFailedTurn).not.toHaveBeenCalled();
		expect(failedAutomatic.client.sentMessages.length).toBe(messagesBeforeStaleContinue + 1);

		const staleRecoveredProcess = createTestProcessInstance({
			lifecycleStatus: "active",
			currentExecution: { kind: "server_turn", id: "trn_stale_recovered" },
			metadata: buildFailedTurnRecoveryMetadata("trn_stale_recovered"),
		});
		const staleRecovered = await startProcessTopic({ process: staleRecoveredProcess });
		const messagesBeforeRecoveredContinue = staleRecovered.client.sentMessages.length;
		await clickButton(staleRecovered.client, `c:${staleRecoveredProcess.id}`);
		expect(staleRecovered.continueFailedTurn).not.toHaveBeenCalled();
		expect(staleRecovered.client.sentMessages.length).toBe(messagesBeforeRecoveredContinue + 1);
	});

	it("rejects non-allowlisted users", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const { client, queueInputs } = await startProcessTopic({ process });

		await sendText(client, "not allowed", { from: { id: 999 } });

		expect(queueInputs).not.toHaveBeenCalled();
	});

	it("executes action directly when actionModelSelection is disabled", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "waiting" });
		const harness = setupBridge(
			{ process, actions: [approveAction] },
			testConfig({ actionModelSelection: { enabled: false } }),
		);
		await harness.bridge.start();
		harness.events.emit("process_created", {
			instanceId: process.id,
			process,
			projects: [],
		});
		await flushAsyncWork(5);

		await clickButton(harness.client, callbackData(harness.client, "Approve"));

		expect(harness.executeAction).toHaveBeenCalledWith(
			process.id,
			approveAction.id,
			{},
			expect.objectContaining({ source: "ui", origin: "external_interface" }),
		);
	});

	it("prompts for model selection with an enabled service and llm_turn action", async () => {
		const harness = await setupActionModelSelection();

		await clickButton(harness.client, callbackData(harness.client, "Approve"));

		// Should prompt for model, not execute immediately
		expect(harness.executeAction).not.toHaveBeenCalled();
		expect(harness.client.sentMessages.at(-1)?.text).toContain("Next-turn model for");
	});

	it("selects model profile via button and passes nextTurnModelProfileId", async () => {
		const harness = await setupActionModelSelection();

		// Trigger model prompt
		await clickButton(harness.client, callbackData(harness.client, "Approve"));
		expect(harness.executeAction).not.toHaveBeenCalled();

		// Click the local_qwen button
		await clickButton(harness.client, callbackData(harness.client, "local_qwen"));

		expect(harness.executeAction).toHaveBeenCalledWith(
			harness.process.id,
			approveAction.id,
			{},
			expect.objectContaining({
				source: "ui",
				origin: "external_interface",
				nextTurnModelProfileId: "local_qwen",
			}),
		);
	});

	it("/skip keeps the default model without an override", async () => {
		const harness = await setupActionModelSelection({
			selection: modelSelection({
				profiles: defaultSelectionProfiles.slice(0, 1),
			}),
		});

		// Trigger model prompt
		await clickButton(harness.client, callbackData(harness.client, "Approve"));
		expect(harness.executeAction).not.toHaveBeenCalled();

		// Send /skip
		await sendText(harness.client, "/skip");

		expect(harness.executeAction).toHaveBeenCalledWith(
			harness.process.id,
			approveAction.id,
			{},
			expect.objectContaining({
				source: "ui",
				origin: "external_interface",
			}),
		);
		// Should not have nextTurnModelProfileId
		expect(harness.executeAction.mock.lastCall[3]).not.toHaveProperty("nextTurnModelProfileId");
	});

	it("executes action directly for non-llm_turn preview", async () => {
		const harness = await setupActionModelSelection({
			selection: modelSelection({
				result: { kind: "not_applicable", turnId: null, description: null },
			}),
		});

		await clickButton(harness.client, callbackData(harness.client, "Approve"));

		// Should execute directly, no model prompt
		expect(harness.executeAction).toHaveBeenCalledWith(
			harness.process.id,
			approveAction.id,
			{},
			expect.objectContaining({ source: "ui", origin: "external_interface" }),
		);
	});

	it("logs operational preview failures safely and executes the action directly", async () => {
		const harness = await setupActionModelSelection({
			selection: modelSelection({
				result: { kind: "operational_failure", code: "instance_tree_unavailable" },
			}),
		});

		await clickButton(harness.client, callbackData(harness.client, "Approve"));

		expect(harness.executeAction).toHaveBeenCalled();
		expect(harness.logger.warn).toHaveBeenCalledWith(
			{ code: "instance_tree_unavailable" },
			"Action model preview unavailable; falling back to direct execution",
		);
	});

	it("falls back to direct execution when service returns null configuration", async () => {
		const harness = await setupActionModelSelection({
			selection: modelSelection({ profiles: null }),
		});

		await clickButton(harness.client, callbackData(harness.client, "Approve"));

		expect(harness.executeAction).toHaveBeenCalledWith(
			harness.process.id,
			approveAction.id,
			{},
			expect.objectContaining({ source: "ui", origin: "external_interface" }),
		);
	});

	it("selects model by text input matching profile id", async () => {
		const harness = await setupActionModelSelection({
			selection: modelSelection({
				profiles: defaultSelectionProfiles.slice(0, 1),
			}),
		});

		// Trigger model prompt
		await clickButton(harness.client, callbackData(harness.client, "Approve"));
		expect(harness.executeAction).not.toHaveBeenCalled();

		// Type the profile id as text
		await sendText(harness.client, "claude_fast");

		expect(harness.executeAction).toHaveBeenCalledWith(
			harness.process.id,
			approveAction.id,
			{},
			expect.objectContaining({
				nextTurnModelProfileId: "claude_fast",
			}),
		);
	});

	it("selects model by numeric index", async () => {
		const harness = await setupActionModelSelection();

		// Trigger model prompt
		await clickButton(harness.client, callbackData(harness.client, "Approve"));

		// Select second profile by number 2
		await sendText(harness.client, "2");

		expect(harness.executeAction).toHaveBeenCalledWith(
			harness.process.id,
			approveAction.id,
			{},
			expect.objectContaining({
				nextTurnModelProfileId: "local_qwen",
			}),
		);
	});

	it("cancels action model prompt via /cancel", async () => {
		const harness = await setupActionModelSelection({
			selection: modelSelection({
				profiles: defaultSelectionProfiles.slice(0, 1),
			}),
		});

		// Trigger model prompt
		await clickButton(harness.client, callbackData(harness.client, "Approve"));
		expect(harness.executeAction).not.toHaveBeenCalled();

		// Cancel
		await sendText(harness.client, "/cancel");

		expect(harness.executeAction).not.toHaveBeenCalled();
		expect(harness.client.sentMessages.at(-1)?.text).toContain("Cancelled");
	});
});

describe("model filtering via allowedModelProfileIds", () => {
	it("shows only allowed profiles in action model selection", async () => {
		const harness = await setupActionModelSelection({
			config: {
				allowedModelProfileIds: ["claude_fast"],
			},
		});

		await clickButton(harness.client, callbackData(harness.client, "Approve"));

		// local_qwen should NOT appear; only claude_fast is allowed
		expect(harness.executeAction).not.toHaveBeenCalled();
		const buttons = allButtons(harness.client);
		expect(buttons.some((b) => b.text === "claude_fast")).toBe(true);
		expect(buttons.some((b) => b.text === "local_qwen")).toBe(false);
	});

	it("falls back to direct execution when all profiles are filtered out", async () => {
		const harness = await setupActionModelSelection({
			config: {
				allowedModelProfileIds: ["nonexistent_profile"],
			},
			selection: modelSelection({
				profiles: defaultSelectionProfiles.slice(0, 1),
			}),
		});

		await clickButton(harness.client, callbackData(harness.client, "Approve"));

		// Should execute directly without showing model prompt
		expect(harness.executeAction).toHaveBeenCalledWith(
			harness.process.id,
			approveAction.id,
			{},
			expect.objectContaining({ source: "ui", origin: "external_interface" }),
		);
	});

	it("shows only allowed profiles in recovery model selection", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "error",
			currentExecution: { kind: "server_turn", id: "trn_failed" },
			metadata: buildFailedTurnRecoveryMetadata("trn_failed"),
		});
		const harness = await setupActionModelSelection({
			process,
			actions: [],
			config: {
				allowedModelProfileIds: ["claude_fast"],
			},
		});

		// Trigger retry from recovery button
		await clickButton(harness.client, callbackData(harness.client, "Retry"));

		// Should prompt for model, not execute retry immediately
		expect(harness.retryProcess).not.toHaveBeenCalled();
		const buttons = allButtons(harness.client);
		expect(buttons.some((b) => b.text === "claude_fast")).toBe(true);
		expect(buttons.some((b) => b.text === "local_qwen")).toBe(false);
		expect(harness.client.sentMessages.at(-1)?.text).toContain("Next-turn model for");
	});

	it("shows only allowed profiles in launch model editing", async () => {
		const { bridge, client } = setupLaunchBridge({ modelSchema: testModelSchema() });
		// Override bridge config with filtering
		bridgeInternals(bridge).input = {
			...bridgeInternals(bridge).input,
			config: testConfig({ allowedModelProfileIds: ["claude_fast"] }),
		};
		await bridge.start();

		await completeLaunchFormToReview(client);
		expect(client.sentMessages.at(-1)?.text).toContain("Model setup");
		await clickUnmappedTopicButton(client, "Change models");

		// local_qwen should NOT appear; only claude_fast is allowed
		const buttons = allButtons(client);
		expect(buttons.some((b) => b.text === "claude_fast")).toBe(true);
		expect(buttons.some((b) => b.text === "local_qwen")).toBe(false);
	});
});

describe("turn-started model label", () => {
	it("includes model label in turn-started message for LLM turns", async () => {
		const modelProfileId = "deepseek-v4-flash";
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const harness = setupBridge({ process });
		bridgeInternals(harness.bridge).processModelSelection = modelSelection({
			profiles: [
				{
					id: modelProfileId,
					label: "DeepSeek V4 Flash",
					description: "fast",
					availability: "available",
				},
			],
		});
		await harness.bridge.start();
		harness.events.emit("process_created", {
			instanceId: process.id,
			process,
			projects: [],
		});
		await flushAsyncWork(5);

		harness.events.emit("turn_started", {
			instanceId: process.id,
			turnRecord: {
				id: "trn_1",
				instanceId: process.id,
				turnId: "implement",
				turnType: "llm",
				status: "running",
				attemptNumber: 1,
				parentTurnRecordId: null,
				pathType: "primary",
				forkPiEntryId: null,
				turnStartRecordId: "tsr_trn_1",
				acceptedWorkerLeaseId: "wls_trn_1",
				resultPiEntryId: null,
				modelProfileId,
				turnResultMarkdown: null,
				errorSummary: null,
				errorClass: null,
				startedAt: new Date().toISOString(),
				endedAt: null,
			},
		});
		await flushAsyncWork(5);

		const sent = harness.client.sentMessages.at(-1);
		expect(sent?.text).toContain("Started");
		expect(sent?.text).toContain("Implement");
		expect(sent?.text).toContain("DeepSeek V4 Flash");
		expect(sent?.text).toContain(formatPathTypeLabel("primary"));
	});

	it("does not include model label for non-LLM turns", async () => {
		const process = createTestProcessInstance({ lifecycleStatus: "active" });
		const harness = setupBridge({ process });
		await harness.bridge.start();
		harness.events.emit("process_created", {
			instanceId: process.id,
			process,
			projects: [],
		});
		await flushAsyncWork(5);

		harness.events.emit("turn_started", {
			instanceId: process.id,
			turnRecord: {
				id: "trn_1",
				instanceId: process.id,
				turnId: "await_approval",
				turnType: "human",
				status: "running",
				attemptNumber: 1,
				parentTurnRecordId: null,
				pathType: "primary",
				forkPiEntryId: null,
				turnStartRecordId: null,
				acceptedWorkerLeaseId: null,
				resultPiEntryId: null,
				modelProfileId: null,
				turnResultMarkdown: null,
				errorSummary: null,
				errorClass: null,
				startedAt: new Date().toISOString(),
				endedAt: null,
			},
		});
		await flushAsyncWork(5);

		const sent = harness.client.sentMessages.at(-1);
		expect(sent?.text).toContain("Started");
		expect(sent?.text).toContain("Await Approval");
		expect(sent?.text).not.toContain("(model:");
		expect(sent?.text).toContain(formatPathTypeLabel("primary"));
	});
});

describe("turn path type in outcome and actions prompt", () => {
	it("includes path type label in turn outcome messages", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "active",
			selectedTurnId: "implement",
		});
		const harness = setupBridge({ process });
		await harness.bridge.start();
		harness.events.emit("process_created", {
			instanceId: process.id,
			process,
			projects: [],
		});
		await flushAsyncWork(5);

		// Simulate turn_started → sets lastTurnInfo
		harness.events.emit("turn_started", {
			instanceId: process.id,
			turnRecord: {
				id: "trn_1",
				instanceId: process.id,
				turnId: "implement",
				turnType: "llm",
				status: "running",
				attemptNumber: 1,
				parentTurnRecordId: null,
				pathType: "root_branch",
				forkPiEntryId: null,
				turnStartRecordId: "tsr_trn_1",
				acceptedWorkerLeaseId: "wls_trn_1",
				resultPiEntryId: null,
				modelProfileId: null,
				turnResultMarkdown: null,
				errorSummary: null,
				errorClass: null,
				startedAt: new Date().toISOString(),
				endedAt: null,
			},
		});
		await flushAsyncWork(5);

		// Emit turn_outcome with markdown — pathType comes from lastTurnInfo
		harness.events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_1",
			turnId: "implement",
			outcome: "implemented",
			params: {},
			turnResultMarkdown: "Changes applied.",
		});
		await flushAsyncWork(5);

		const outcomeMessage = harness.client.sentMessages.at(-1);
		expect(outcomeMessage?.text).toContain("implement.implemented");
		expect(outcomeMessage?.text).toContain(formatPathTypeLabel("root_branch"));
	});

	it("includes path type label in actions prompt after turn outcome", async () => {
		const process = createTestProcessInstance({
			lifecycleStatus: "active",
			selectedTurnId: "implement",
		});
		const actions = [{ id: "approve", label: "Approve" }];
		const harness = setupBridge({ process, actions });
		await harness.bridge.start();
		harness.events.emit("process_created", {
			instanceId: process.id,
			process,
			projects: [],
		});
		await flushAsyncWork(5);

		harness.events.emit("turn_started", {
			instanceId: process.id,
			turnRecord: {
				id: "trn_2",
				instanceId: process.id,
				turnId: "review",
				turnType: "llm",
				status: "running",
				attemptNumber: 1,
				parentTurnRecordId: null,
				pathType: "leaf_branch",
				forkPiEntryId: null,
				turnStartRecordId: "tsr_trn_2",
				acceptedWorkerLeaseId: "wls_trn_2",
				resultPiEntryId: null,
				modelProfileId: null,
				turnResultMarkdown: null,
				errorSummary: null,
				errorClass: null,
				startedAt: new Date().toISOString(),
				endedAt: null,
			},
		});
		await flushAsyncWork(5);

		const waitingProcess = { ...process, lifecycleStatus: "waiting" as const };
		const originalGetById = bridgeInternals(harness.bridge).input.deps.processes.getById;
		bridgeInternals(harness.bridge).input.deps.processes.getById = () => waitingProcess;

		harness.events.emit("turn_outcome", {
			instanceId: process.id,
			turnRecordId: "trn_2",
			turnId: "review",
			outcome: "review_complete",
			params: {},
			turnResultMarkdown: "Looks good.",
		});
		await flushAsyncWork(5);

		bridgeInternals(harness.bridge).input.deps.processes.getById = originalGetById;

		const actionsMessage = harness.client.sentMessages.at(-1);
		expect(actionsMessage?.text).toContain("Approve");
		expect(actionsMessage?.text).toContain(formatPathTypeLabel("leaf_branch"));
	});
});
