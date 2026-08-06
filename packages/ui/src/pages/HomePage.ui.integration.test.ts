// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { get } from "svelte/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchLauncherDefaults,
	fetchLauncherModelConfigPreview,
	fetchLauncherOptions,
	fetchLaunchers,
	launchLauncher,
	previewCronExpression,
	type UiLauncherSummary,
	updateScheduledLaunch,
} from "../lib/api.js";
import { futureExecutions } from "../lib/processes.svelte.js";
import { consumePendingRetryConfig } from "../lib/retry-config.svelte.js";
import { buildHomePath, navigate } from "../lib/router.svelte";
import HomePage from "./HomePage.svelte";

const launcherModelConfigSchema = {
	availableProfiles: [
		{
			id: "claude_fast",
			label: "claude_fast — anthropic/claude-sonnet-4-20250514",
			description: "Thinking level: medium",
			availability: "available",
		},
		{
			id: "local_qwen",
			label: "local_qwen — ollama/qwen2.5-coder:14b",
			description: "Thinking level: low",
			availability: "available",
		},
	],
	llmTurns: [{ turnId: "draft_plan", description: "Draft plan" }],
} as const;

const launcherProcessFlow = {
	processId: "test-process",
	entryTurnIds: ["draft_plan"],
	spine: ["draft_plan", "commit"],
	nodes: [
		{
			turnId: "draft_plan",
			description: "Draft plan",
			turnType: "llm" as const,
			role: "spine" as const,
			spineIndex: 0,
			anchorTurnId: null,
			isEntry: true,
		},
		{
			turnId: "commit",
			description: "Commit",
			turnType: "automatic" as const,
			role: "spine" as const,
			spineIndex: 1,
			anchorTurnId: null,
			isEntry: false,
		},
	],
	edges: [
		{
			from: "draft_plan",
			to: "commit",
			lifecycleStatus: null,
			kind: "forward" as const,
			label: "plan_saved",
		},
		{
			from: "commit",
			to: null,
			lifecycleStatus: "completed" as const,
			kind: "terminal" as const,
			label: null,
		},
	],
	endStates: [
		{ lifecycleStatus: "aborted" as const, synthetic: true },
		{ lifecycleStatus: "completed" as const, synthetic: false },
	],
} as const;

const launchers: UiLauncherSummary[] = [
	{
		id: "launcher-a",
		processId: "test-process",
		displayName: "Test Process",
		label: "Launcher A",
		description: "Primary launcher",
		card: { title: "Launcher A", description: "Primary launcher" },
		launchConfigSchema: {
			id: "launcher-a-form",
			title: "Launcher A",
			fields: [{ id: "repoPath", label: "Repo Path", kind: "text", required: true }],
			submitLabel: "Launch",
		},
		modelConfigSchema: launcherModelConfigSchema,
		processFlow: launcherProcessFlow,
		skills: [{ id: "review", label: "Review", description: "Review the change" }],
	},
	{
		id: "launcher-b",
		processId: "test-process",
		displayName: "Test Process",
		label: "Launcher B",
		description: "Secondary launcher",
		card: { title: "Launcher B", description: "Secondary launcher" },
		launchConfigSchema: {
			id: "launcher-b-form",
			title: "Launcher B",
			fields: [{ id: "repoPath", label: "Repo Path", kind: "text", required: true }],
			submitLabel: "Launch",
		},
	},
];

vi.mock("../lib/api.js", () => ({
	fetchLaunchers: vi.fn(),
	fetchLauncherDefaults: vi.fn(),
	fetchLauncherModelConfigPreview: vi.fn(),
	fetchLauncherOptions: vi.fn(),
	launchLauncher: vi.fn(),
	previewCronExpression: vi.fn(),
	updateScheduledLaunch: vi.fn(),
}));

vi.mock("../lib/retry-config.svelte.js", () => ({
	consumePendingRetryConfig: vi.fn(),
}));

vi.mock("../lib/router.svelte", () => ({
	buildFutureLaunchPath: vi.fn(
		(futureExecutionId: string) => `/future-launches/${futureExecutionId}`,
	),
	buildHomePath: vi.fn((launcherId?: string | null) =>
		launcherId ? `/?launcher=${launcherId}` : "/",
	),
	buildProcessPath: vi.fn((instanceId: string) => `/processes/${instanceId}`),
	navigate: vi.fn(),
}));

vi.mock("../lib/process-launch-notices.svelte", () => ({
	queueProcessLaunchNotice: vi.fn(),
}));

vi.mock("../lib/ws.svelte", () => ({
	wsStore: {
		subscribe(run: (value: { reconnectCount: number }) => void) {
			run({ reconnectCount: 0 });
			return () => {};
		},
	},
}));

function resetDefaultMocks() {
	vi.mocked(fetchLaunchers).mockResolvedValue(launchers.map((launcher) => ({ ...launcher })));
	vi.mocked(fetchLauncherDefaults).mockImplementation(async (launcherId: string) => ({
		title: launcherId === "launcher-a" ? "Default Title A" : "Default Title B",
		defaults: {
			repoPath: launcherId === "launcher-a" ? "/default/a" : "/default/b",
		},
		modelConfig: {},
	}));
	vi.mocked(fetchLauncherModelConfigPreview).mockResolvedValue({
		defaultModel: {
			source: "catalog_default",
			profile: launcherModelConfigSchema.availableProfiles[0],
		},
		turns: [
			{
				turnId: "draft_plan",
				description: "Draft plan",
				effective: {
					source: "catalog_default",
					profile: launcherModelConfigSchema.availableProfiles[0],
				},
			},
		],
	});
	vi.mocked(fetchLauncherOptions).mockResolvedValue({});
	vi.mocked(previewCronExpression).mockResolvedValue(new Date().toISOString());
	vi.mocked(updateScheduledLaunch).mockResolvedValue({
		kind: "failure",
		status: 500,
		error: "not implemented in test",
	});
	vi.mocked(launchLauncher).mockResolvedValue({
		kind: "failure",
		status: 500,
		error: "not implemented in test",
	});
	futureExecutions.set([]);
	vi.mocked(consumePendingRetryConfig).mockReturnValue(null);
}

resetDefaultMocks();

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function setInputValue(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
	select.value = value;
	select.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForSelector(
	target: HTMLElement,
	selector: string,
	timeoutMs = 250,
): Promise<HTMLElement> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const element = target.querySelector(selector);
		if (element instanceof HTMLElement) {
			return element;
		}
		await flush();
	}
	throw new Error(`Timed out waiting for selector: ${selector}`);
}

afterEach(() => {
	document.body.innerHTML = "";
	vi.clearAllMocks();
	resetDefaultMocks();
});

describe("HomePage", () => {
	it("renders the process gallery at the root start route", async () => {
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(HomePage, { target, props: { launcherId: null } });
		await flush();

		expect(target.querySelector('[data-section="process-gallery"]')).not.toBeNull();
		expect(target.querySelector('[data-section="launcher-form"]')).toBeNull();
		expect(target.querySelectorAll("[data-process-card-id]").length).toBe(2);

		unmount(app);
	});

	it("renders launcher setup from a deep link and includes the process flow", async () => {
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(HomePage, { target, props: { launcherId: "launcher-a" } });
		await flush();

		expect(target.querySelector('[data-section="process-configure"]')).not.toBeNull();
		expect(target.querySelector('[data-section="launcher-form"]')).not.toBeNull();
		const flow = target.querySelector('[data-section="process-flow-diagram"]');
		expect(flow).not.toBeNull();
		expect(flow?.querySelector('[data-flow-turn-id="draft_plan"]')).not.toBeNull();

		unmount(app);
	});

	it("falls back to the gallery when a deep-linked launcher is unavailable", async () => {
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(HomePage, { target, props: { launcherId: "missing-launcher" } });
		await flush();

		expect(target.querySelector('[data-section="process-gallery"]')).not.toBeNull();
		expect(target.querySelector('[data-state="launcher-unavailable"]')).not.toBeNull();
		expect(target.querySelector('[data-section="launcher-form"]')).toBeNull();

		unmount(app);
	});

	it("selecting a gallery card navigates to that launcher setup", async () => {
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(HomePage, { target, props: { launcherId: null } });
		await flush();

		(target.querySelector('[data-launcher-id="launcher-a"]') as HTMLButtonElement | null)?.click();
		await flush();

		expect(buildHomePath).toHaveBeenCalledWith("launcher-a");
		expect(navigate).toHaveBeenCalledWith("/?launcher=launcher-a");

		unmount(app);
	});

	it("stores a newly scheduled launch before navigating to its detail route", async () => {
		const scheduledLaunch = {
			id: "fut_scheduled_1",
			kind: "launch" as const,
			scheduleKind: "once" as const,
			processId: "test-process",
			nextRunAt: "2026-01-01T13:05:00.000Z",
			cronExpression: null,
			title: "Scheduled process",
			subtitle: "Scheduled start",
			launcherId: "launcher-a",
			launcherLabel: "Launcher A",
			launchTitle: "Scheduled process",
			launcherInput: { repoPath: "/work/repo" },
			skillIds: [],
			modelConfig: {},
		};
		vi.mocked(launchLauncher).mockResolvedValue({
			kind: "scheduled",
			futureExecution: scheduledLaunch,
		});

		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(HomePage, { target, props: { launcherId: "launcher-a" } });
		await flush();

		setInputValue(
			(await waitForSelector(target, "#launcher-a-form-repoPath")) as HTMLInputElement,
			"/work/repo",
		);
		const scheduleModeInputs = target.querySelectorAll<HTMLInputElement>(
			'input[name="launcher-a-form-schedule-mode"]',
		);
		const laterRadio = scheduleModeInputs[1];
		expect(laterRadio).toBeInstanceOf(HTMLInputElement);
		laterRadio.checked = true;
		laterRadio.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();
		setInputValue(
			(await waitForSelector(target, "#launcher-a-form-schedule-date")) as HTMLInputElement,
			"2026-01-01",
		);
		setSelectValue(
			(await waitForSelector(target, "#launcher-a-form-schedule-hour")) as HTMLSelectElement,
			"13",
		);
		setSelectValue(
			(await waitForSelector(target, "#launcher-a-form-schedule-minute")) as HTMLSelectElement,
			"05",
		);

		target
			.querySelector("form")
			?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await flush();

		expect(get(futureExecutions)).toContainEqual({
			id: scheduledLaunch.id,
			kind: scheduledLaunch.kind,
			scheduleKind: scheduledLaunch.scheduleKind,
			processId: scheduledLaunch.processId,
			instanceId: null,
			nextRunAt: scheduledLaunch.nextRunAt,
			cronExpression: scheduledLaunch.cronExpression,
			title: scheduledLaunch.title,
			status: "scheduled",
			blockedReason: null,
			launcherId: scheduledLaunch.launcherId,
			launcherLabel: scheduledLaunch.launcherLabel,
			initialPromptPreview: null,
		});
		expect(navigate).toHaveBeenCalledWith("/future-launches/fut_scheduled_1");

		unmount(app);
	});

	it("clears retry prefill state when backing out and choosing another launcher", async () => {
		vi.mocked(consumePendingRetryConfig)
			.mockReset()
			.mockReturnValueOnce({
				launcherId: "launcher-a",
				title: "Retry Title",
				launcherInput: { repoPath: "/retry/a" },
				skillIds: ["review"],
				modelConfig: {},
			})
			.mockReturnValue(null);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(HomePage, { target });
		await flush();

		const initialInput = (await waitForSelector(
			target,
			"#launcher-a-form-repoPath",
		)) as HTMLInputElement;
		const initialTitleInput = (await waitForSelector(
			target,
			"#launcher-a-form-process-title",
		)) as HTMLInputElement;
		expect(initialInput.value).toBe("/retry/a");
		expect(initialTitleInput.value).toBe("Retry Title");
		expect(
			target.querySelector<HTMLInputElement>(
				'[data-section="launcher-skills"] input[value="review"]',
			)?.checked,
		).toBe(true);
		expect(buildHomePath).toHaveBeenCalledWith("launcher-a");

		(target.querySelector(".page-header-button") as HTMLButtonElement | null)?.click();
		await flush();
		expect(target.querySelector('[data-section="process-gallery"]')).not.toBeNull();

		(target.querySelector('[data-launcher-id="launcher-b"]') as HTMLButtonElement | null)?.click();
		await flush();

		const secondLauncherInput = (await waitForSelector(
			target,
			"#launcher-b-form-repoPath",
		)) as HTMLInputElement;
		const secondLauncherTitleInput = (await waitForSelector(
			target,
			"#launcher-b-form-process-title",
		)) as HTMLInputElement;
		expect(secondLauncherInput.value).toBe("/default/b");
		expect(secondLauncherTitleInput.value).toBe("Default Title B");

		(target.querySelector(".page-header-button") as HTMLButtonElement | null)?.click();
		await flush();
		(target.querySelector('[data-launcher-id="launcher-a"]') as HTMLButtonElement | null)?.click();
		await flush();

		const returnedInput = (await waitForSelector(
			target,
			"#launcher-a-form-repoPath",
		)) as HTMLInputElement;
		const returnedTitleInput = (await waitForSelector(
			target,
			"#launcher-a-form-process-title",
		)) as HTMLInputElement;
		expect(returnedInput.value).toBe("/default/a");
		expect(returnedInput.value).not.toBe("/retry/a");
		expect(returnedTitleInput.value).toBe("Default Title A");

		unmount(app);
	});

	it("auto-opens advanced model config when retry state includes turn overrides", async () => {
		vi.mocked(consumePendingRetryConfig)
			.mockReset()
			.mockReturnValueOnce({
				launcherId: "launcher-a",
				title: "Retry Title",
				launcherInput: { repoPath: "/retry/a" },
				skillIds: [],
				modelConfig: {
					turnConfigs: {
						draft_plan: { modelProfileId: "local_qwen" },
					},
				},
			})
			.mockReturnValue(null);
		vi.mocked(fetchLauncherModelConfigPreview).mockResolvedValue({
			defaultModel: {
				source: "catalog_default",
				profile: launcherModelConfigSchema.availableProfiles[0],
			},
			turns: [
				{
					turnId: "draft_plan",
					description: "Draft plan",
					effective: {
						source: "instance_turn_config",
						profile: launcherModelConfigSchema.availableProfiles[1],
					},
				},
			],
		});

		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(HomePage, { target });
		await flush();

		const summaryCard = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-summary"]',
		)) as HTMLElement;
		const turnList = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-turn-list"]',
		)) as HTMLElement;
		const turnGroup = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-turn-list"] [data-turn-id="draft_plan"]',
		)) as HTMLElement;
		expect(summaryCard.dataset.editing).toBe("true");
		expect(turnList.dataset.open).toBe("true");
		expect(turnList.dataset.overrideCount).toBe("1");
		expect(turnGroup.dataset.effectiveSource).toBe("instance_turn_config");
		expect(turnGroup.dataset.effectiveProfileId).toBe("local_qwen");

		unmount(app);
	});

	it("keeps per-step settings collapsed when retry state only changes the process default", async () => {
		vi.mocked(consumePendingRetryConfig)
			.mockReset()
			.mockReturnValueOnce({
				launcherId: "launcher-a",
				title: "Retry Title",
				launcherInput: { repoPath: "/retry/a" },
				skillIds: [],
				modelConfig: {
					defaultModelProfileId: "local_qwen",
				},
			})
			.mockReturnValue(null);
		vi.mocked(fetchLauncherModelConfigPreview).mockResolvedValue({
			defaultModel: {
				source: "instance_default",
				profile: launcherModelConfigSchema.availableProfiles[1],
			},
			turns: [
				{
					turnId: "draft_plan",
					description: "Draft plan",
					effective: {
						source: "instance_default",
						profile: launcherModelConfigSchema.availableProfiles[1],
					},
				},
			],
		});

		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(HomePage, { target });
		await flush();

		const summaryCard = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-summary"]',
		)) as HTMLElement;
		const defaultGroup = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-default"]',
		)) as HTMLElement;
		expect(summaryCard.dataset.editing).toBe("false");
		expect(summaryCard.dataset.customizationMode).toBe("default_only");
		expect(defaultGroup.dataset.effectiveSource).toBe("instance_default");
		expect(defaultGroup.dataset.effectiveProfileId).toBe("local_qwen");

		unmount(app);
	});
});
