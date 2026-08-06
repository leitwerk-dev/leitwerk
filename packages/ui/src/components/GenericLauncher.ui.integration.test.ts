// @vitest-environment jsdom

import type { ProcessInstance } from "@leitwerk-dev/domain";
import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchLauncherDefaults,
	fetchLauncherModelConfigPreview,
	fetchLauncherOptions,
	fetchLauncherRecentValues,
	type LauncherModelConfigDefaults,
	type LauncherModelConfigPreview,
	launchLauncher,
	previewCronExpression,
	type ScheduleConfigInput,
	type UiLauncherSummary,
	updateScheduledLaunch,
} from "../lib/api.js";
import GenericLauncher from "./GenericLauncher.svelte";

const serverDefaultProfile = {
	id: "claude_fast",
	label: "claude_fast — anthropic/claude-sonnet-4-20250514",
	description: "Thinking level: medium",
	availability: "available" as const,
};

const localProfile = {
	id: "local_qwen",
	label: "local_qwen — ollama/qwen2.5-coder:14b",
	description: "Thinking level: low",
	availability: "available" as const,
};

const availableProfiles = [serverDefaultProfile, localProfile] as const;

function createLauncher(
	overrides: Partial<UiLauncherSummary["launchConfigSchema"]> = {},
): UiLauncherSummary {
	return {
		id: "test-launcher",
		processId: "test-process",
		displayName: "Test Process",
		label: "Test Launcher",
		description: "Launch a test process",
		card: {
			title: "Test Launcher",
			description: "Launch a test process",
		},
		launchConfigSchema: {
			id: "test-launcher-form",
			title: "Test Launcher",
			fields: [
				{
					id: "repoPath",
					label: "Repo Path",
					kind: "text",
					required: true,
					...(overrides.fields?.[0] ?? {}),
				},
			],
			submitLabel: "Launch Process",
			...overrides,
		},
		modelConfigSchema: {
			availableProfiles,
			llmTurns: [
				{ turnId: "draft_plan", description: "Draft plan" },
				{ turnId: "implement_change", description: "Implement change" },
			],
		},
	};
}

function createPreview(
	overrides: Partial<LauncherModelConfigPreview> & {
		draftPlanEffective?: LauncherModelConfigPreview["turns"][number]["effective"];
		implementChangeEffective?: LauncherModelConfigPreview["turns"][number]["effective"];
	} = {},
): LauncherModelConfigPreview {
	return {
		defaultModel: overrides.defaultModel ?? {
			source: "catalog_default",
			profile: serverDefaultProfile,
		},
		turns: [
			{
				turnId: "draft_plan",
				description: "Draft plan",
				effective:
					overrides.draftPlanEffective ??
					({ source: "process_config_turn", profile: localProfile } as const),
			},
			{
				turnId: "implement_change",
				description: "Implement change",
				effective:
					overrides.implementChangeEffective ??
					({ source: "catalog_default", profile: serverDefaultProfile } as const),
			},
		],
	};
}

vi.mock("../lib/api.js", () => ({
	fetchLauncherDefaults: vi.fn(),
	fetchLauncherModelConfigPreview: vi.fn(),
	fetchLauncherOptions: vi.fn(),
	fetchLauncherRecentValues: vi.fn(),
	launchLauncher: vi.fn(),
	previewCronExpression: vi.fn(),
	updateScheduledLaunch: vi.fn(),
}));

function resetDefaultMocks() {
	vi.mocked(fetchLauncherDefaults).mockResolvedValue({
		title: null,
		defaults: {
			repoPath: "/tmp/default-repo",
		},
		modelConfig: {},
	});
	vi.mocked(fetchLauncherModelConfigPreview).mockResolvedValue(createPreview());
	vi.mocked(fetchLauncherOptions).mockResolvedValue({});
	vi.mocked(fetchLauncherRecentValues).mockResolvedValue({});
	vi.mocked(previewCronExpression).mockResolvedValue(new Date(2026, 3, 24, 18, 45).toISOString());
	vi.mocked(updateScheduledLaunch).mockResolvedValue({
		kind: "failure",
		status: 500,
		error: "not implemented in test",
	});
	vi.mocked(launchLauncher).mockResolvedValue({
		kind: "success",
		process: { id: "proc_1" } as ProcessInstance,
		projects: [],
	});
}

resetDefaultMocks();

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
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

function mountSubject(
	options: {
		launcher?: UiLauncherSummary;
		initialTitle?: string | null;
		initialSkillIds?: readonly string[] | null;
		initialModelConfig?: LauncherModelConfigDefaults | null;
		initialSchedule?: ScheduleConfigInput | null;
	} = {},
) {
	const target = document.createElement("div");
	document.body.appendChild(target);
	const onLaunched = vi.fn();
	const app = mount(GenericLauncher, {
		target,
		props: {
			launcher: options.launcher ?? createLauncher(),
			initialTitle: options.initialTitle,
			initialSkillIds: options.initialSkillIds ?? null,
			initialModelConfig: options.initialModelConfig ?? null,
			initialSchedule: options.initialSchedule ?? null,
			onLaunched,
		},
	});
	return { app, onLaunched, target };
}

async function getModelSummary(target: HTMLElement): Promise<HTMLElement> {
	return waitForSelector(target, '[data-section="launcher-model-config-summary"]');
}

async function getDefaultModelGroup(target: HTMLElement): Promise<HTMLElement> {
	return waitForSelector(target, '[data-section="launcher-model-config-default"]');
}

async function getAdvancedEditor(target: HTMLElement): Promise<HTMLElement> {
	const summary = await getModelSummary(target);
	const deadline = Date.now() + 250;
	while (Date.now() < deadline) {
		const turnList = target.querySelector('[data-section="launcher-model-config-turn-list"]');
		if (summary.dataset.editing === "true" && turnList instanceof HTMLElement) {
			return turnList;
		}
		await flush();
	}
	throw new Error("Timed out waiting for per-step model editing to open");
}

async function toggleAdvancedEditor(target: HTMLElement) {
	const button = (await waitForSelector(
		target,
		'[data-action="toggle-model-config-editor"]',
	)) as HTMLButtonElement;
	button.click();
	await flush();
	return button;
}

async function ensureAdvancedEditorOpen(target: HTMLElement) {
	const summary = await getModelSummary(target);
	if (summary.dataset.editing !== "true") {
		await toggleAdvancedEditor(target);
	}
	return getAdvancedEditor(target);
}

afterEach(() => {
	document.body.innerHTML = "";
	window.localStorage.clear();
	vi.clearAllMocks();
	resetDefaultMocks();
	vi.useRealTimers();
});

describe("GenericLauncher", () => {
	it("shows the current summary mode and all effective turn models from the preview", async () => {
		const { app, target } = mountSubject();
		await flush();

		const summary = await getModelSummary(target);
		const draftPlanSummaryTurn = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-summary-turn-list"] [data-turn-id="draft_plan"]',
		)) as HTMLElement;
		const implementChangeSummaryTurn = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-summary-turn-list"] [data-turn-id="implement_change"]',
		)) as HTMLElement;

		expect(vi.mocked(fetchLauncherModelConfigPreview)).toHaveBeenCalledWith(
			"test-launcher",
			{ repoPath: "/tmp/default-repo" },
			{},
		);
		expect(summary.dataset.summaryMode).toBe("recommended");
		expect(summary.dataset.customizationMode).toBe("recommended");
		expect(draftPlanSummaryTurn.dataset.effectiveSource).toBe("process_config_turn");
		expect(draftPlanSummaryTurn.dataset.effectiveProfileId).toBe("local_qwen");
		expect(draftPlanSummaryTurn.dataset.modelName).toBe("local_qwen");
		expect(implementChangeSummaryTurn.dataset.effectiveSource).toBe("catalog_default");
		expect(implementChangeSummaryTurn.dataset.effectiveProfileId).toBe("claude_fast");
		expect(implementChangeSummaryTurn.dataset.modelName).toBe("claude_fast");
		expect(summary.dataset.editing).toBe("false");
		expect(target.querySelector("#test-launcher-form-draft_plan-model-profile")).toBeNull();

		unmount(app);
	});

	it("shows the built-in title field and prefills it from launcher defaults", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: "Suggested title",
			defaults: {
				repoPath: "/tmp/default-repo",
			},
			modelConfig: {},
		});

		const { app, target } = mountSubject();
		await flush();

		const titleInput = (await waitForSelector(
			target,
			"#test-launcher-form-process-title",
		)) as HTMLInputElement;
		expect(titleInput.value).toBe("Suggested title");

		unmount(app);
	});

	it("uses the explicit built-in title input when submitting", async () => {
		const { app, target, onLaunched } = mountSubject({ initialTitle: "Retry title" });
		await flush();

		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		expect(launchLauncher).toHaveBeenCalledWith(
			"test-launcher",
			"Retry title",
			{ repoPath: "/tmp/default-repo" },
			{},
			{ mode: "now" },
			[],
		);
		expect(onLaunched).toHaveBeenCalledWith("proc_1");

		unmount(app);
	});

	it("preserves initial skill selections when submitting", async () => {
		const launcher = {
			...createLauncher(),
			skills: [{ id: "review", label: "Review", description: null }],
		};
		const { app, target } = mountSubject({ launcher, initialSkillIds: ["review"] });
		await flush();

		expect((target.querySelector('input[value="review"]') as HTMLInputElement).checked).toBe(true);
		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		expect(launchLauncher).toHaveBeenCalledWith(
			"test-launcher",
			null,
			{ repoPath: "/tmp/default-repo" },
			{},
			{ mode: "now" },
			["review"],
		);

		unmount(app);
	});

	it("keeps the built-in title field blank when an explicit null initial title is provided", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: "Suggested title",
			defaults: {
				repoPath: "/tmp/default-repo",
			},
			modelConfig: {},
		});

		const { app, target } = mountSubject({ initialTitle: null });
		await flush();

		const titleInput = (await waitForSelector(
			target,
			"#test-launcher-form-process-title",
		)) as HTMLInputElement;
		expect(titleInput.value).toBe("");

		unmount(app);
	});

	it("defers dependent refreshes while typing in textarea fields until blur", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: null,
			defaults: {
				prompt: "",
			},
			modelConfig: {},
		});

		const { app, target } = mountSubject({
			launcher: createLauncher({
				fields: [
					{
						id: "prompt",
						label: "Prompt",
						kind: "textarea",
						required: true,
					},
				],
			}),
		});
		await flush();

		const promptField = (await waitForSelector(
			target,
			"#test-launcher-form-prompt",
		)) as HTMLTextAreaElement;
		expect(vi.mocked(fetchLauncherModelConfigPreview)).toHaveBeenCalledTimes(1);

		promptField.value = "Ship it";
		promptField.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		expect(vi.mocked(fetchLauncherModelConfigPreview)).toHaveBeenCalledTimes(1);

		promptField.dispatchEvent(new Event("blur"));
		await flush();

		expect(vi.mocked(fetchLauncherModelConfigPreview)).toHaveBeenCalledTimes(2);
		expect(vi.mocked(fetchLauncherModelConfigPreview)).toHaveBeenLastCalledWith(
			"test-launcher",
			{ prompt: "Ship it" },
			{},
		);

		unmount(app);
	});

	it("preserves same-model step recommendations in the summary and full editor", async () => {
		vi.mocked(fetchLauncherModelConfigPreview).mockResolvedValue(
			createPreview({
				defaultModel: { source: "instance_default", profile: localProfile },
				draftPlanEffective: { source: "process_config_turn", profile: localProfile },
				implementChangeEffective: { source: "instance_default", profile: localProfile },
			}),
		);

		const { app, target } = mountSubject();
		await flush();

		const summaryTurn = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-summary-turn-list"] [data-turn-id="draft_plan"]',
		)) as HTMLElement;
		await ensureAdvancedEditorOpen(target);
		const draftPlanTurnGroup = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-turn-list"] [data-turn-id="draft_plan"]',
		)) as HTMLElement;

		expect(summaryTurn.dataset.effectiveSource).toBe("process_config_turn");
		expect(summaryTurn.dataset.modelName).toBe("local_qwen");
		expect(draftPlanTurnGroup.dataset.modelState).toBe("recommended");
		expect(draftPlanTurnGroup.dataset.effectiveSource).toBe("process_config_turn");

		unmount(app);
	});

	it("shows the recommended default inline and keeps it out of the explicit option list", async () => {
		const { app, target } = mountSubject();
		await flush();
		await ensureAdvancedEditorOpen(target);

		const defaultModelSelect = (await waitForSelector(
			target,
			"#test-launcher-form-default-model-profile",
		)) as HTMLSelectElement;
		const draftPlanSelect = (await waitForSelector(
			target,
			"#test-launcher-form-draft_plan-model-profile",
		)) as HTMLSelectElement;

		expect(defaultModelSelect.options[0]?.value).toBe("");
		expect(defaultModelSelect.options[0]?.text).toBe("Recommended (claude_fast)");
		expect(Array.from(defaultModelSelect.options).map((option) => option.value)).toEqual([
			"",
			"local_qwen",
		]);
		expect(draftPlanSelect.options[0]?.value).toBe("");
		expect(draftPlanSelect.options[0]?.text).toBe("Use process default");
		expect(target.textContent).not.toContain("Thinking level");

		unmount(app);
	});

	it("keeps unavailable profiles visible but prevents selecting them as the launch default", async () => {
		const unavailableProfile = {
			...localProfile,
			availability: "unavailable" as const,
			safeReason: "Credential is missing",
		};
		const launcher = createLauncher();
		launcher.modelConfigSchema = {
			availableProfiles: [serverDefaultProfile, unavailableProfile],
			llmTurns: [
				{ turnId: "draft_plan", description: "Draft plan" },
				{ turnId: "implement_change", description: "Implement change" },
			],
		};
		const { app, target } = mountSubject({ launcher });
		await flush();
		await ensureAdvancedEditorOpen(target);

		const defaultModelSelect = (await waitForSelector(
			target,
			"#test-launcher-form-default-model-profile",
		)) as HTMLSelectElement;
		const unavailableOption = Array.from(defaultModelSelect.options).find(
			(option) => option.value === "local_qwen",
		);

		expect(unavailableOption?.disabled).toBe(true);
		expect(unavailableOption?.text).toContain("unavailable");

		unmount(app);
	});

	it("prefills launcher-provided model config from defaults and auto-opens the editor", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: null,
			defaults: {
				repoPath: "/tmp/default-repo",
			},
			modelConfig: {
				defaultModelProfileId: "local_qwen",
				turnConfigs: {
					draft_plan: { modelProfileId: "claude_fast" },
				},
			},
		});

		const { app, target } = mountSubject();
		await flush();

		const summary = await getModelSummary(target);
		const editor = await getAdvancedEditor(target);
		const defaultModelSelect = (await waitForSelector(
			target,
			"#test-launcher-form-default-model-profile",
		)) as HTMLSelectElement;
		const draftPlanSelect = (await waitForSelector(
			target,
			"#test-launcher-form-draft_plan-model-profile",
		)) as HTMLSelectElement;

		expect(summary.dataset.summaryMode).toBe("adjusted");
		expect(summary.dataset.customizationMode).toBe("mixed");
		expect(editor.dataset.customizationMode).toBe("mixed");
		expect(editor.dataset.overrideCount).toBe("1");
		expect(defaultModelSelect.value).toBe("local_qwen");
		expect(draftPlanSelect.value).toBe("claude_fast");
		expect(vi.mocked(fetchLauncherModelConfigPreview)).toHaveBeenCalledWith(
			"test-launcher",
			{ repoPath: "/tmp/default-repo" },
			{
				defaultModelProfileId: "local_qwen",
				turnConfigs: { draft_plan: { modelProfileId: "claude_fast" } },
			},
		);

		unmount(app);
	});

	it("lets the operator change the default model without opening per-step settings", async () => {
		vi.mocked(fetchLauncherModelConfigPreview)
			.mockResolvedValueOnce(createPreview())
			.mockResolvedValueOnce(
				createPreview({
					defaultModel: { source: "instance_default", profile: localProfile },
					implementChangeEffective: { source: "instance_default", profile: localProfile },
				}),
			);

		const { app, target } = mountSubject();
		await flush();

		const initialSummary = await getModelSummary(target);
		expect(initialSummary.dataset.editing).toBe("false");

		const defaultModelSelect = (await waitForSelector(
			target,
			"#test-launcher-form-default-model-profile",
		)) as HTMLSelectElement;
		defaultModelSelect.value = "local_qwen";
		defaultModelSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();

		const summary = await getModelSummary(target);
		const defaultModelGroup = await getDefaultModelGroup(target);
		const draftPlanSummaryTurn = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-summary-turn-list"] [data-turn-id="draft_plan"]',
		)) as HTMLElement;
		const implementChangeSummaryTurn = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-summary-turn-list"] [data-turn-id="implement_change"]',
		)) as HTMLElement;

		expect(summary.dataset.summaryMode).toBe("adjusted");
		expect(summary.dataset.customizationMode).toBe("default_only");
		expect(defaultModelGroup.dataset.effectiveSource).toBe("instance_default");
		expect(defaultModelGroup.dataset.effectiveProfileId).toBe("local_qwen");
		expect(defaultModelGroup.dataset.modelState).toBe("custom");
		expect(draftPlanSummaryTurn.dataset.adjusted).toBe("false");
		expect(implementChangeSummaryTurn.dataset.adjusted).toBe("false");
		expect(vi.mocked(fetchLauncherModelConfigPreview)).toHaveBeenLastCalledWith(
			"test-launcher",
			{ repoPath: "/tmp/default-repo" },
			{ defaultModelProfileId: "local_qwen" },
		);

		unmount(app);
	});

	it("toggles inline per-step model editing from the summary action", async () => {
		const { app, target } = mountSubject();
		await flush();

		const summary = await getModelSummary(target);
		expect(summary.dataset.editing).toBe("false");
		expect(target.querySelector("#test-launcher-form-draft_plan-model-profile")).toBeNull();
		expect(target.querySelector('[data-action="reset-model-config"]')).toBeNull();

		const toggleButton = await toggleAdvancedEditor(target);
		expect(toggleButton.getAttribute("aria-expanded")).toBe("true");
		expect(summary.dataset.editing).toBe("true");
		expect(target.querySelector("#test-launcher-form-draft_plan-model-profile")).not.toBeNull();
		expect(target.querySelector('[data-action="reset-model-config"]')).toBeNull();

		const draftPlanSelect = (await waitForSelector(
			target,
			"#test-launcher-form-draft_plan-model-profile",
		)) as HTMLSelectElement;
		draftPlanSelect.value = "local_qwen";
		draftPlanSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();

		const toggleButtonAgain = await toggleAdvancedEditor(target);
		expect(toggleButtonAgain.getAttribute("aria-expanded")).toBe("false");
		expect(summary.dataset.editing).toBe("false");
		expect(target.querySelector("#test-launcher-form-draft_plan-model-profile")).toBeNull();
		expect(target.querySelector('[data-action="reset-model-config"]')).not.toBeNull();

		await toggleAdvancedEditor(target);
		expect(summary.dataset.editing).toBe("true");
		expect(target.querySelector('[data-action="reset-model-config"]')).toBeNull();

		unmount(app);
	});

	it("cancelling inline per-step editing restores the previous turn overrides", async () => {
		vi.mocked(fetchLauncherModelConfigPreview)
			.mockResolvedValueOnce(
				createPreview({
					draftPlanEffective: { source: "instance_turn_config", profile: localProfile },
				}),
			)
			.mockResolvedValueOnce(
				createPreview({
					draftPlanEffective: { source: "instance_turn_config", profile: serverDefaultProfile },
				}),
			)
			.mockResolvedValueOnce(
				createPreview({
					draftPlanEffective: { source: "instance_turn_config", profile: localProfile },
				}),
			);

		const { app, target } = mountSubject({
			initialModelConfig: {
				turnConfigs: {
					draft_plan: { modelProfileId: "local_qwen" },
				},
			},
		});
		await flush();
		await ensureAdvancedEditorOpen(target);

		const draftPlanSelect = (await waitForSelector(
			target,
			"#test-launcher-form-draft_plan-model-profile",
		)) as HTMLSelectElement;
		draftPlanSelect.value = "claude_fast";
		draftPlanSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();

		const cancelButton = (await waitForSelector(
			target,
			'[data-action="cancel-model-config-editor"]',
		)) as HTMLButtonElement;
		cancelButton.click();
		await flush();

		const summary = await getModelSummary(target);
		const draftPlanSummaryTurn = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-summary-turn-list"] [data-turn-id="draft_plan"]',
		)) as HTMLElement;

		expect(summary.dataset.editing).toBe("false");
		expect(target.querySelector("#test-launcher-form-draft_plan-model-profile")).toBeNull();
		expect(draftPlanSummaryTurn.dataset.effectiveProfileId).toBe("local_qwen");
		expect(draftPlanSummaryTurn.dataset.adjusted).toBe("true");

		unmount(app);
	});

	it("resetting per-step model changes keeps the selected default model", async () => {
		const { app, target, onLaunched } = mountSubject({
			initialModelConfig: {
				defaultModelProfileId: "local_qwen",
				turnConfigs: {
					draft_plan: { modelProfileId: "claude_fast" },
				},
			},
		});
		await flush();

		await toggleAdvancedEditor(target);
		const resetButton = (await waitForSelector(
			target,
			'[data-action="reset-model-config"]',
		)) as HTMLButtonElement;
		resetButton.click();
		await flush();

		const summary = await getModelSummary(target);
		await ensureAdvancedEditorOpen(target);
		const defaultModelSelect = (await waitForSelector(
			target,
			"#test-launcher-form-default-model-profile",
		)) as HTMLSelectElement;
		const draftPlanSelect = (await waitForSelector(
			target,
			"#test-launcher-form-draft_plan-model-profile",
		)) as HTMLSelectElement;

		expect(summary.dataset.summaryMode).toBe("adjusted");
		expect(summary.dataset.customizationMode).toBe("default_only");
		expect(defaultModelSelect.value).toBe("local_qwen");
		expect(draftPlanSelect.value).toBe("");
		expect(target.querySelector('[data-action="reset-model-config"]')).toBeNull();

		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		expect(launchLauncher).toHaveBeenCalledWith(
			"test-launcher",
			null,
			{ repoPath: "/tmp/default-repo" },
			{ defaultModelProfileId: "local_qwen" },
			{ mode: "now" },
			[],
		);
		expect(onLaunched).toHaveBeenCalledWith("proc_1");

		unmount(app);
	});

	it("keeps blank overrides out of the launch payload", async () => {
		const { app, target, onLaunched } = mountSubject({
			initialModelConfig: {
				turnConfigs: {
					draft_plan: { modelProfileId: "local_qwen" },
				},
			},
		});
		await flush();
		await ensureAdvancedEditorOpen(target);

		const draftPlanSelect = (await waitForSelector(
			target,
			"#test-launcher-form-draft_plan-model-profile",
		)) as HTMLSelectElement;
		draftPlanSelect.value = "";
		draftPlanSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();

		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		expect(launchLauncher).toHaveBeenCalledWith(
			"test-launcher",
			null,
			{ repoPath: "/tmp/default-repo" },
			{},
			{ mode: "now" },
			[],
		);
		expect(onLaunched).toHaveBeenCalledWith("proc_1");

		unmount(app);
	});

	it("includes turn overrides in the launch payload when set", async () => {
		const { app, target, onLaunched } = mountSubject({
			initialModelConfig: {
				turnConfigs: {
					draft_plan: { modelProfileId: "local_qwen" },
				},
			},
		});
		await flush();

		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		expect(launchLauncher).toHaveBeenCalledWith(
			"test-launcher",
			null,
			{ repoPath: "/tmp/default-repo" },
			{ turnConfigs: { draft_plan: { modelProfileId: "local_qwen" } } },
			{ mode: "now" },
			[],
		);
		expect(onLaunched).toHaveBeenCalledWith("proc_1");

		unmount(app);
	});

	it("drops blank required-field default notices until the user submits", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: null,
			defaults: { repoPath: "" },
			modelConfig: {},
			warnings: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
		});

		const { app, target } = mountSubject();
		await flush();

		expect(target.querySelector('[data-section="launcher-defaults-notice"]')).toBeNull();

		unmount(app);
	});

	it("keeps non-empty default warnings in an explicit review state", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: null,
			defaults: { repoPath: "/tmp/default-repo" },
			modelConfig: {},
			warnings: [
				{
					code: "custom_rule",
					fieldId: "repoPath",
					message: "repoPath must be reviewed before launch",
				},
			],
		});

		const { app, target } = mountSubject();
		await flush();

		const notice = (await waitForSelector(
			target,
			'[data-section="launcher-defaults-notice"]',
		)) as HTMLElement;

		expect(notice.dataset.tone).toBe("warning");
		expect(notice.querySelector(".warning-list")).not.toBeNull();

		unmount(app);
	});

	it("focuses the first invalid field and keeps the banner summary short after validation errors", async () => {
		vi.mocked(launchLauncher).mockResolvedValue({
			kind: "validation_error",
			errors: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
		});

		const { app, target } = mountSubject();
		await flush();

		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		const banner = (await waitForSelector(
			target,
			'[data-section="launcher-form-error-banner"]',
		)) as HTMLElement;
		const repoInput = (await waitForSelector(
			target,
			"#test-launcher-form-repoPath",
		)) as HTMLInputElement;
		const fieldErrors = target.querySelector("#test-launcher-form-repoPath-errors");

		expect(banner.dataset.fieldErrorCount).toBe("1");
		expect(banner.dataset.formErrorCount).toBe("0");
		expect(banner.querySelector("ul")).toBeNull();
		expect(document.activeElement).toBe(repoInput);
		expect(fieldErrors?.textContent).not.toContain("repoPath");

		unmount(app);
	});

	it("stores and reuses recent values for opted-in text fields after a successful launch", async () => {
		const launcher = createLauncher({
			fields: [
				{
					id: "repoPath",
					label: "Repo Path",
					kind: "text",
					required: true,
					rememberRecentValues: true,
				},
			],
		});
		const firstMount = mountSubject({ launcher });
		await flush();

		const repoInput = (await waitForSelector(
			firstMount.target,
			"#test-launcher-form-repoPath",
		)) as HTMLInputElement;
		repoInput.value = "/tmp/recent-repo";
		repoInput.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		(firstMount.target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();
		unmount(firstMount.app);

		const secondMount = mountSubject({ launcher });
		await flush();

		const recentChip = (await waitForSelector(
			secondMount.target,
			'[data-field-recents="repoPath"] [data-recent-value="/tmp/recent-repo"]',
		)) as HTMLButtonElement;
		recentChip.click();
		await flush();

		const secondRepoInput = (await waitForSelector(
			secondMount.target,
			"#test-launcher-form-repoPath",
		)) as HTMLInputElement;
		expect(secondRepoInput.value).toBe("/tmp/recent-repo");

		unmount(secondMount.app);
	});

	it("surfaces server-provided recent values for opted-in text fields", async () => {
		const launcher = createLauncher({
			fields: [
				{
					id: "repoPath",
					label: "Repo Path",
					kind: "text",
					required: true,
					rememberRecentValues: true,
				},
			],
		});
		vi.mocked(fetchLauncherRecentValues).mockResolvedValueOnce({
			repoPath: ["/tmp/server-recent-repo"],
		});

		const { app, target } = mountSubject({ launcher });
		await flush();

		const recentChip = (await waitForSelector(
			target,
			'[data-field-recents="repoPath"] [data-recent-value="/tmp/server-recent-repo"]',
		)) as HTMLButtonElement;
		recentChip.click();
		await flush();

		const repoInput = (await waitForSelector(
			target,
			"#test-launcher-form-repoPath",
		)) as HTMLInputElement;
		expect(repoInput.value).toBe("/tmp/server-recent-repo");

		unmount(app);
	});

	it("treats recent-value persistence as best effort and still completes the launch", async () => {
		const launcher = createLauncher({
			fields: [
				{
					id: "repoPath",
					label: "Repo Path",
					kind: "text",
					required: true,
					rememberRecentValues: true,
				},
			],
		});
		const setItemSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
			throw new Error("quota exceeded");
		});
		const { app, target, onLaunched } = mountSubject({ launcher });
		await flush();

		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		expect(onLaunched).toHaveBeenCalledWith("proc_1");

		setItemSpy.mockRestore();
		unmount(app);
	});

	it("does not remember credential-bearing absolute repo urls", async () => {
		const launcher = createLauncher({
			fields: [
				{
					id: "repoPath",
					label: "Repo Path",
					kind: "text",
					required: true,
					rememberRecentValues: true,
				},
			],
		});
		const firstMount = mountSubject({ launcher });
		await flush();

		const repoInput = (await waitForSelector(
			firstMount.target,
			"#test-launcher-form-repoPath",
		)) as HTMLInputElement;
		repoInput.value = "https://token@example.com/private/repo.git";
		repoInput.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		(firstMount.target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();
		unmount(firstMount.app);

		const secondMount = mountSubject({ launcher });
		await flush();

		expect(secondMount.target.querySelector('[data-field-recents="repoPath"]')).toBeNull();

		unmount(secondMount.app);
	});

	it("stores the submitted recent value even if the field changes before the launch resolves", async () => {
		const launcher = createLauncher({
			fields: [
				{
					id: "repoPath",
					label: "Repo Path",
					kind: "text",
					required: true,
					rememberRecentValues: true,
				},
			],
		});
		const deferredLaunch = createDeferred<Awaited<ReturnType<typeof launchLauncher>>>();
		vi.mocked(launchLauncher).mockReturnValueOnce(deferredLaunch.promise);
		const firstMount = mountSubject({ launcher });
		await flush();

		const repoInput = (await waitForSelector(
			firstMount.target,
			"#test-launcher-form-repoPath",
		)) as HTMLInputElement;
		repoInput.value = "/tmp/submitted-repo";
		repoInput.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		(firstMount.target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		repoInput.value = "/tmp/edited-after-submit";
		repoInput.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		deferredLaunch.resolve({
			kind: "success",
			process: { id: "proc_1" } as ProcessInstance,
			projects: [],
		});
		await flush();
		unmount(firstMount.app);

		const secondMount = mountSubject({ launcher });
		await flush();

		expect(
			secondMount.target.querySelector(
				'[data-field-recents="repoPath"] [data-recent-value="/tmp/submitted-repo"]',
			),
		).not.toBeNull();
		expect(
			secondMount.target.querySelector(
				'[data-field-recents="repoPath"] [data-recent-value="/tmp/edited-after-submit"]',
			),
		).toBeNull();

		unmount(secondMount.app);
	});

	it("uses a combined once picker with explicit 24-hour hour and minute selectors", async () => {
		const { app, target } = mountSubject();
		await flush();

		const scheduleRadios = target.querySelectorAll<HTMLInputElement>(
			'input[name="test-launcher-form-schedule-mode"]',
		);
		scheduleRadios[1]?.click();
		await flush();

		const oncePicker = (await waitForSelector(
			target,
			'[data-section="launcher-schedule-once-picker"]',
		)) as HTMLElement;
		const dateInput = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-date",
		)) as HTMLInputElement;
		const hourSelect = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-hour",
		)) as HTMLSelectElement;
		const minuteSelect = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-minute",
		)) as HTMLSelectElement;

		expect(oncePicker.dataset.timeFormat).toBe("24-hour");
		expect(target.querySelector('input[type="time"]')).toBeNull();
		expect(hourSelect.options[0]?.value).toBe("");
		expect(hourSelect.options[1]?.value).toBe("00");
		expect(hourSelect.options[24]?.value).toBe("23");

		dateInput.value = "2026-04-24";
		dateInput.dispatchEvent(new Event("input", { bubbles: true }));
		hourSelect.value = "18";
		hourSelect.dispatchEvent(new Event("change", { bubbles: true }));
		minuteSelect.value = "45";
		minuteSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();

		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		expect(launchLauncher).toHaveBeenCalledWith(
			"test-launcher",
			null,
			{ repoPath: "/tmp/default-repo" },
			{},
			{ mode: "once", runAt: new Date(2026, 3, 24, 18, 45, 0, 0).toISOString() },
			[],
		);

		unmount(app);
	});

	it("prefills the combined once picker from the initial schedule", async () => {
		const { app, target } = mountSubject({
			initialSchedule: {
				mode: "once",
				runAt: new Date(2026, 3, 24, 18, 45, 0, 0).toISOString(),
			},
		});
		await flush();

		const dateInput = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-date",
		)) as HTMLInputElement;
		const hourSelect = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-hour",
		)) as HTMLSelectElement;
		const minuteSelect = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-minute",
		)) as HTMLSelectElement;

		expect(dateInput.value).toBe("2026-04-24");
		expect(hourSelect.value).toBe("18");
		expect(minuteSelect.value).toBe("45");

		unmount(app);
	});

	it("prefills the combined once picker with the current date and time", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(2026, 3, 24, 18, 45, 0, 0));
		const { app, target } = mountSubject();
		await flush();

		const scheduleRadios = target.querySelectorAll<HTMLInputElement>(
			'input[name="test-launcher-form-schedule-mode"]',
		);
		scheduleRadios[1]?.click();
		await flush();

		const dateInput = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-date",
		)) as HTMLInputElement;
		const hourSelect = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-hour",
		)) as HTMLSelectElement;
		const minuteSelect = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-minute",
		)) as HTMLSelectElement;

		expect(dateInput.value).toBe("2026-04-24");
		expect(hourSelect.value).toBe("18");
		expect(minuteSelect.value).toBe("45");

		unmount(app);
	});

	it("fills the cron field from example buttons and refreshes the preview", async () => {
		const { app, target } = mountSubject();
		await flush();

		const scheduleRadios = target.querySelectorAll<HTMLInputElement>(
			'input[name="test-launcher-form-schedule-mode"]',
		);
		scheduleRadios[2]?.click();
		await flush();

		const cronExample = (await waitForSelector(
			target,
			'[data-cron-example="0 13 * * *"]',
		)) as HTMLButtonElement;
		cronExample.click();
		await flush();

		const cronInput = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-cron",
		)) as HTMLInputElement;
		expect(cronInput.value).toBe("0 13 * * *");
		expect(vi.mocked(previewCronExpression)).toHaveBeenLastCalledWith("0 13 * * *");

		unmount(app);
	});

	it("ignores stale cron previews after leaving cron mode", async () => {
		const deferredPreview = createDeferred<string>();
		vi.mocked(previewCronExpression).mockReturnValueOnce(deferredPreview.promise);
		const { app, target } = mountSubject();
		await flush();

		const scheduleRadios = target.querySelectorAll<HTMLInputElement>(
			'input[name="test-launcher-form-schedule-mode"]',
		);
		scheduleRadios[2]?.click();
		await flush();

		const cronInput = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-cron",
		)) as HTMLInputElement;
		cronInput.value = "0 13 * * *";
		cronInput.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		scheduleRadios[0]?.click();
		await flush();

		deferredPreview.resolve(new Date(2026, 3, 24, 18, 45).toISOString());
		await flush();

		expect(target.textContent).not.toContain("Next run:");
		unmount(app);
	});

	it("ignores stale cron previews after the cron field is cleared", async () => {
		const deferredPreview = createDeferred<string>();
		vi.mocked(previewCronExpression).mockReturnValueOnce(deferredPreview.promise);
		const { app, target } = mountSubject();
		await flush();

		const scheduleRadios = target.querySelectorAll<HTMLInputElement>(
			'input[name="test-launcher-form-schedule-mode"]',
		);
		scheduleRadios[2]?.click();
		await flush();

		const cronInput = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-cron",
		)) as HTMLInputElement;
		cronInput.value = "0 13 * * *";
		cronInput.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		cronInput.value = "";
		cronInput.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		deferredPreview.resolve(new Date(2026, 3, 24, 18, 45).toISOString());
		await flush();

		expect(target.textContent).not.toContain("Next run:");
		unmount(app);
	});
});
