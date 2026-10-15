// @vitest-environment jsdom

import type { ProcessInstance } from "@leitwerk-dev/domain";
import type {
	FutureLaunchSummary,
	LauncherModelConfigDefaults,
	LauncherModelConfigPreview,
	ScheduleConfigInput,
	UiLauncherSummary,
} from "@leitwerk-dev/protocol/http-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fetchLauncherDefaults,
	fetchLauncherModelConfigPreview,
	fetchLauncherOptions,
	fetchLauncherRecentValues,
	launchLauncher,
	previewCronExpression,
	updateScheduledLaunch,
	validateLauncher,
} from "../lib/api.js";
import { mountTest, unmountTests } from "../test-support/mount.js";
import { flushUi as flush, waitForSelector } from "../test-support/wait.js";
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

function createRecentValuesLauncher() {
	const launcher = createLauncher();
	launcher.launchConfigSchema.fields[0].rememberRecentValues = true;
	return launcher;
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
	validateLauncher: vi.fn(),
}));

function resetDefaultMocks() {
	vi.mocked(validateLauncher).mockResolvedValue([]);
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

async function waitForValidation(target: HTMLElement) {
	await flush();
	await vi.waitFor(() => {
		expect(target.querySelector(".validation-status")?.textContent).not.toContain(
			"Checking values",
		);
	});
}

async function selectScheduleMode(target: HTMLElement, mode: ScheduleConfigInput["mode"]) {
	const radios = target.querySelectorAll<HTMLInputElement>(
		'input[name="test-launcher-form-schedule-mode"]',
	);
	radios[["now", "once", "cron"].indexOf(mode)]?.click();
	await flush();
}

async function getScheduleControls(target: HTMLElement) {
	const field = (id: string) => waitForSelector(target, `#test-launcher-form-schedule-${id}`);
	return {
		dateInput: (await field("date")) as HTMLInputElement,
		hourSelect: (await field("hour")) as HTMLSelectElement,
		minuteSelect: (await field("minute")) as HTMLSelectElement,
	};
}

function setControlValue(control: HTMLInputElement | HTMLSelectElement, value: string) {
	control.value = value;
	control.dispatchEvent(
		new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
	);
}

function mountSubject(
	options: {
		launcher?: UiLauncherSummary;
		initialTitle?: string | null;
		initialValues?: Record<string, unknown> | null;
		initialSkillIds?: readonly string[] | null;
		initialModelConfig?: LauncherModelConfigDefaults | null;
		initialSchedule?: ScheduleConfigInput | null;
		editingFutureLaunch?: FutureLaunchSummary;
	} = {},
) {
	const onLaunched = vi.fn();
	return {
		...mountTest(GenericLauncher, {
			...options,
			launcher: options.launcher ?? createLauncher(),
			onLaunched,
		}),
		onLaunched,
	};
}

async function getModelSummary(target: HTMLElement): Promise<HTMLElement> {
	return waitForSelector(target, '[data-section="launcher-model-config-summary"]');
}

async function getDefaultModelGroup(target: HTMLElement): Promise<HTMLElement> {
	return waitForSelector(target, '[data-section="launcher-model-config-default"]');
}

async function getModelSelect(target: HTMLElement, turnId = "default") {
	return (await waitForSelector(
		target,
		`#test-launcher-form-${turnId}-model-profile`,
	)) as HTMLSelectElement;
}

function getSummaryTurn(target: HTMLElement, turnId: string) {
	return waitForSelector(
		target,
		`[data-section="launcher-model-config-summary-turn-list"] [data-turn-id="${turnId}"]`,
	);
}

function getAdvancedEditor(target: HTMLElement): Promise<HTMLElement> {
	return waitForSelector(
		target,
		'[data-section="launcher-model-config-summary"][data-editing="true"] [data-section="launcher-model-config-turn-list"]',
	);
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

afterEach(async () => {
	await unmountTests();
	window.localStorage.clear();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	resetDefaultMocks();
	vi.useRealTimers();
});

describe("GenericLauncher", () => {
	it("shows the current summary mode and all effective turn models from the preview", async () => {
		const { target } = mountSubject();
		await flush();

		const summary = await getModelSummary(target);
		const draftPlanSummaryTurn = await getSummaryTurn(target, "draft_plan");
		const implementChangeSummaryTurn = await getSummaryTurn(target, "implement_change");

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
	});

	it("shows the built-in title field and prefills it from launcher defaults", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: "Suggested title",
			defaults: {
				repoPath: "/tmp/default-repo",
			},
			modelConfig: {},
		});

		const { target } = mountSubject();
		await flush();

		const titleInput = (await waitForSelector(
			target,
			"#test-launcher-form-process-title",
		)) as HTMLInputElement;
		expect(titleInput.value).toBe("Suggested title");
	});

	it("uses the explicit built-in title input when submitting", async () => {
		const { target, onLaunched } = mountSubject({ initialTitle: "Retry title" });
		await flush();

		await waitForValidation(target);
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
	});

	it("preserves initial skill selections when submitting", async () => {
		const launcher = {
			...createLauncher(),
			skills: [{ id: "review", label: "Review", description: null }],
		};
		const { target } = mountSubject({ launcher, initialSkillIds: ["review"] });
		await flush();

		expect((target.querySelector('input[value="review"]') as HTMLInputElement).checked).toBe(true);
		await waitForValidation(target);
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
	});

	it("submits multiple selections and retains unavailable values when options fail to refresh", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: null,
			defaults: { groups: "services\nretained" },
			modelConfig: {},
		});
		vi.mocked(fetchLauncherOptions).mockResolvedValue({
			groups: [
				{ value: "services", label: "Services" },
				{ value: "monitoring", label: "Monitoring" },
			],
		});
		const { target } = mountSubject({
			launcher: createLauncher({
				fields: [{ id: "groups", label: "Groups", kind: "select", multiple: true, required: true }],
			}),
		});
		await flush();
		const checkbox = (label: string) => {
			const input = [...target.querySelectorAll("#test-launcher-form-groups label")]
				.find((element) => element.textContent?.trim() === label)
				?.querySelector("input");
			if (!(input instanceof HTMLInputElement)) throw new Error(`Missing group ${label}`);
			return input;
		};
		expect(checkbox("Services").checked).toBe(true);
		expect(checkbox("retained (unavailable)").checked).toBe(true);
		vi.mocked(fetchLauncherOptions).mockRejectedValue(new Error("Provider unavailable"));
		checkbox("Monitoring").click();
		await flush();
		expect(target.textContent).toContain("We couldn't refresh the latest options");
		expect(checkbox("Monitoring").checked).toBe(true);
		expect(checkbox("retained (unavailable)").checked).toBe(true);
		checkbox("Services").click();
		await flush();
		await waitForValidation(target);
		target.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
		await flush();
		expect(launchLauncher).toHaveBeenCalledWith(
			"test-launcher",
			null,
			{ groups: "retained\nmonitoring" },
			{},
			{ mode: "now" },
			[],
		);
	});

	it("keeps the built-in title field blank when an explicit null initial title is provided", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: "Suggested title",
			defaults: {
				repoPath: "/tmp/default-repo",
			},
			modelConfig: {},
		});

		const { target } = mountSubject({ initialTitle: null });
		await flush();

		const titleInput = (await waitForSelector(
			target,
			"#test-launcher-form-process-title",
		)) as HTMLInputElement;
		expect(titleInput.value).toBe("");
	});

	it("defers dependent refreshes while typing in textarea fields until blur", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: null,
			defaults: {
				prompt: "",
			},
			modelConfig: {},
		});

		const { target } = mountSubject({
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
	});

	it("preserves same-model step recommendations in the summary and full editor", async () => {
		vi.mocked(fetchLauncherModelConfigPreview).mockResolvedValue(
			createPreview({
				defaultModel: { source: "instance_default", profile: localProfile },
				draftPlanEffective: { source: "process_config_turn", profile: localProfile },
				implementChangeEffective: { source: "instance_default", profile: localProfile },
			}),
		);

		const { target } = mountSubject();
		await flush();

		const summaryTurn = await getSummaryTurn(target, "draft_plan");
		await ensureAdvancedEditorOpen(target);
		const draftPlanTurnGroup = (await waitForSelector(
			target,
			'[data-section="launcher-model-config-turn-list"] [data-turn-id="draft_plan"]',
		)) as HTMLElement;

		expect(summaryTurn.dataset.effectiveSource).toBe("process_config_turn");
		expect(summaryTurn.dataset.modelName).toBe("local_qwen");
		expect(draftPlanTurnGroup.dataset.modelState).toBe("recommended");
		expect(draftPlanTurnGroup.dataset.effectiveSource).toBe("process_config_turn");
	});

	it("keeps inherited recommendations separate from explicit choices of the same model", async () => {
		const { target } = mountSubject();
		await flush();
		await ensureAdvancedEditorOpen(target);

		const defaultModelSelect = await getModelSelect(target);
		const draftPlanSelect = await getModelSelect(target, "draft_plan");

		expect(defaultModelSelect.options[0]?.value).toBe("");
		expect(defaultModelSelect.options[0]?.text).toBe("Recommended (claude_fast)");
		expect(Array.from(defaultModelSelect.options).map((option) => option.value)).toEqual([
			"",
			"claude_fast",
			"local_qwen",
		]);
		expect(draftPlanSelect.options[0]?.value).toBe("");
		expect(draftPlanSelect.options[0]?.text).toBe("Use inherited value");
		expect(target.textContent).not.toContain("Thinking level");
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
		const { target } = mountSubject({ launcher });
		await flush();
		await ensureAdvancedEditorOpen(target);

		const defaultModelSelect = await getModelSelect(target);
		const unavailableOption = Array.from(defaultModelSelect.options).find(
			(option) => option.value === "local_qwen",
		);

		expect(unavailableOption?.disabled).toBe(true);
		expect(unavailableOption?.text).toContain("unavailable");
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

		const { target } = mountSubject();
		await flush();

		const summary = await getModelSummary(target);
		const editor = await getAdvancedEditor(target);
		const defaultModelSelect = await getModelSelect(target);
		const draftPlanSelect = await getModelSelect(target, "draft_plan");

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

		const { target } = mountSubject();
		await flush();

		const initialSummary = await getModelSummary(target);
		expect(initialSummary.dataset.editing).toBe("false");

		const defaultModelSelect = await getModelSelect(target);
		defaultModelSelect.value = "local_qwen";
		defaultModelSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();

		const summary = await getModelSummary(target);
		const defaultModelGroup = await getDefaultModelGroup(target);
		const draftPlanSummaryTurn = await getSummaryTurn(target, "draft_plan");
		const implementChangeSummaryTurn = await getSummaryTurn(target, "implement_change");

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
	});

	it("toggles inline per-step model editing from the summary action", async () => {
		const { target } = mountSubject();
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

		const draftPlanSelect = await getModelSelect(target, "draft_plan");
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

		const { target } = mountSubject({
			initialModelConfig: {
				turnConfigs: {
					draft_plan: { modelProfileId: "local_qwen" },
				},
			},
		});
		await flush();
		await ensureAdvancedEditorOpen(target);

		const draftPlanSelect = await getModelSelect(target, "draft_plan");
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
		const draftPlanSummaryTurn = await getSummaryTurn(target, "draft_plan");

		expect(summary.dataset.editing).toBe("false");
		expect(target.querySelector("#test-launcher-form-draft_plan-model-profile")).toBeNull();
		expect(draftPlanSummaryTurn.dataset.effectiveProfileId).toBe("local_qwen");
		expect(draftPlanSummaryTurn.dataset.adjusted).toBe("true");
	});

	it("resetting per-step model changes keeps the selected default model", async () => {
		const { target, onLaunched } = mountSubject({
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
		const defaultModelSelect = await getModelSelect(target);
		const draftPlanSelect = await getModelSelect(target, "draft_plan");

		expect(summary.dataset.summaryMode).toBe("adjusted");
		expect(summary.dataset.customizationMode).toBe("default_only");
		expect(defaultModelSelect.value).toBe("local_qwen");
		expect(draftPlanSelect.value).toBe("");
		expect(target.querySelector('[data-action="reset-model-config"]')).toBeNull();

		await waitForValidation(target);
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
	});

	it("keeps blank overrides out of the launch payload", async () => {
		const { target, onLaunched } = mountSubject({
			initialModelConfig: {
				turnConfigs: {
					draft_plan: { modelProfileId: "local_qwen" },
				},
			},
		});
		await flush();
		await ensureAdvancedEditorOpen(target);

		const draftPlanSelect = await getModelSelect(target, "draft_plan");
		draftPlanSelect.value = "";
		draftPlanSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();

		await waitForValidation(target);
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
	});

	it("includes turn overrides in the launch payload when set", async () => {
		const { target, onLaunched } = mountSubject({
			initialModelConfig: {
				turnConfigs: {
					draft_plan: { modelProfileId: "local_qwen" },
				},
			},
		});
		await flush();

		await waitForValidation(target);
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
	});

	it("suppresses blank required-field notices before submission", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: null,
			defaults: { repoPath: "" },
			modelConfig: {},
			warnings: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
		});

		const { target } = mountSubject();
		await flush();

		expect(target.querySelector('[data-section="launcher-defaults-notice"]')).toBeNull();
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

		const { target } = mountSubject();
		await flush();

		const notice = (await waitForSelector(
			target,
			'[data-section="launcher-defaults-notice"]',
		)) as HTMLElement;

		expect(notice.dataset.tone).toBe("warning");
		expect(notice.textContent).toContain("must be reviewed before launch");
	});

	it("focuses the first invalid field and keeps the banner summary short after validation errors", async () => {
		vi.mocked(launchLauncher).mockResolvedValue({
			kind: "validation_error",
			errors: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
		});

		const { target } = mountSubject();
		await flush();

		await waitForValidation(target);
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
	});

	it("stores and reuses recent values for opted-in text fields after a successful launch", async () => {
		const launcher = createRecentValuesLauncher();
		const firstMount = mountSubject({ launcher });
		await flush();

		const repoInput = (await waitForSelector(
			firstMount.target,
			"#test-launcher-form-repoPath",
		)) as HTMLInputElement;
		repoInput.value = "/tmp/recent-repo";
		repoInput.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		await waitForValidation(firstMount.target);
		(firstMount.target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();
		await firstMount.dispose();

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
	});

	it("surfaces server-provided recent values for opted-in text fields", async () => {
		const launcher = createRecentValuesLauncher();
		vi.mocked(fetchLauncherRecentValues).mockResolvedValueOnce({
			repoPath: ["/tmp/server-recent-repo"],
		});

		const { target } = mountSubject({ launcher });
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
	});

	it("treats recent-value persistence as best effort and still completes the launch", async () => {
		const launcher = createRecentValuesLauncher();
		const setItemSpy = vi
			.spyOn(Object.getPrototypeOf(window.localStorage), "setItem")
			.mockImplementationOnce(() => {
				throw new Error("quota exceeded");
			});
		const { target, onLaunched } = mountSubject({ launcher });
		await flush();

		await waitForValidation(target);
		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();

		expect(onLaunched).toHaveBeenCalledWith("proc_1");

		expect(setItemSpy).toHaveBeenCalled();
	});

	it("does not remember credential-bearing absolute repo urls", async () => {
		const launcher = createRecentValuesLauncher();
		const firstMount = mountSubject({ launcher });
		await flush();

		const repoInput = (await waitForSelector(
			firstMount.target,
			"#test-launcher-form-repoPath",
		)) as HTMLInputElement;
		repoInput.value = "https://token@example.com/private/repo.git";
		repoInput.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();

		await waitForValidation(firstMount.target);
		(firstMount.target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await flush();
		expect(firstMount.onLaunched).toHaveBeenCalledWith("proc_1");
		expect(
			window.localStorage.getItem("leitwerk.launcher-recents:test-launcher:repoPath"),
		).toBeNull();
	});

	it("stores the submitted recent value even if the field changes before the launch resolves", async () => {
		const launcher = createRecentValuesLauncher();
		const deferredLaunch = Promise.withResolvers<Awaited<ReturnType<typeof launchLauncher>>>();
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

		await waitForValidation(firstMount.target);
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
		await firstMount.dispose();

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
	});

	it("uses a combined once picker with explicit 24-hour hour and minute selectors", async () => {
		const { target } = mountSubject();
		await flush();

		await selectScheduleMode(target, "once");
		const oncePicker = await waitForSelector(
			target,
			'[data-section="launcher-schedule-once-picker"]',
		);
		const { dateInput, hourSelect, minuteSelect } = await getScheduleControls(target);

		expect(oncePicker.dataset.timeFormat).toBe("24-hour");
		expect(target.querySelector('input[type="time"]')).toBeNull();
		expect(hourSelect.options[0]?.value).toBe("");
		expect(hourSelect.options[1]?.value).toBe("00");
		expect(hourSelect.options[24]?.value).toBe("23");

		setControlValue(dateInput, "2026-04-24");
		setControlValue(hourSelect, "18");
		setControlValue(minuteSelect, "45");
		await flush();

		await waitForValidation(target);
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
	});

	it.each([
		"initial schedule",
		"current date and time",
	])("prefills the combined once picker from the %s", async (source) => {
		const runAt = new Date(2026, 3, 24, 18, 45, 0, 0);
		if (source === "current date and time") {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(runAt);
		}
		const { target } = mountSubject(
			source === "initial schedule"
				? { initialSchedule: { mode: "once", runAt: runAt.toISOString() } }
				: {},
		);
		await flush();
		if (source === "current date and time") await selectScheduleMode(target, "once");
		const { dateInput, hourSelect, minuteSelect } = await getScheduleControls(target);
		expect(dateInput.value).toBe("2026-04-24");
		expect(hourSelect.value).toBe("18");
		expect(minuteSelect.value).toBe("45");
	});

	it("fills the cron field from example buttons and refreshes the preview", async () => {
		const { target } = mountSubject();
		await flush();

		await selectScheduleMode(target, "cron");

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
	});

	it.each([
		"leaving cron mode",
		"clearing the cron field",
	])("ignores stale cron previews after %s", async (action) => {
		const deferredPreview = Promise.withResolvers<string>();
		vi.mocked(previewCronExpression).mockReturnValueOnce(deferredPreview.promise);
		const { target } = mountSubject();
		await flush();
		await selectScheduleMode(target, "cron");
		const cronInput = (await waitForSelector(
			target,
			"#test-launcher-form-schedule-cron",
		)) as HTMLInputElement;
		setControlValue(cronInput, "0 13 * * *");
		await flush();
		if (action === "leaving cron mode") await selectScheduleMode(target, "now");
		else {
			setControlValue(cronInput, "");
			await flush();
		}
		deferredPreview.resolve(new Date(2026, 3, 24, 18, 45).toISOString());
		await flush();
		expect(target.textContent).not.toContain("Next run:");
	});
});

function selectionFixture(initialValues?: Record<string, unknown>) {
	const choices = {
		project: [
			{ value: "one", label: "One" },
			{ value: "two", label: "Two" },
		],
		groups: [
			{ value: "services", label: "Services", selectionValues: ["a", "b"] },
			{ value: "monitoring", label: "Monitoring", selectionValues: ["b", "c"] },
		],
		components: ["a", "b", "c", "d"].map((value) => ({ value, label: `Component ${value}` })),
	};
	vi.mocked(fetchLauncherDefaults).mockResolvedValue({
		title: null,
		defaults: { project: "one", groups: "services", components: "a\nb" },
		modelConfig: {},
	});
	vi.mocked(fetchLauncherOptions).mockResolvedValue(choices);
	const { target } = mountSubject({
		initialValues,
		launcher: createLauncher({
			fields: [
				{ id: "project", label: "Project", kind: "select" },
				{ id: "groups", label: "Groups", kind: "select", multiple: true, resetOn: ["project"] },
				{
					id: "components",
					label: "Components",
					kind: "select",
					multiple: true,
					searchable: true,
					required: true,
					presetsFrom: "groups",
					resetOn: ["project"],
				},
			],
		}),
	});
	const checkbox = (field: string, label: string) => {
		const row = [...target.querySelectorAll(`#test-launcher-form-${field} label`)].find(
			(row) => row.querySelector(".selection-name")?.textContent === label,
		);
		const input = row?.querySelector("input");
		if (!(input instanceof HTMLInputElement)) throw new Error(`Missing option ${label}`);
		return input;
	};
	const selected = () =>
		[
			...target.querySelectorAll<HTMLInputElement>(
				"#test-launcher-form-components input[type=checkbox]:checked",
			),
		].map((input) => input.parentElement?.querySelector(".selection-name")?.textContent);
	return { target, choices, checkbox, selected };
}

describe("launcher selection presets", () => {
	it("supports schema-defined presets and cascades scope resets", async () => {
		vi.mocked(fetchLauncherDefaults).mockResolvedValue({
			title: null,
			defaults: { profile: "first", project: "one", groups: "services" },
			modelConfig: {},
		});
		const { target } = mountSubject({
			launcher: createLauncher({
				fields: [
					{
						id: "profile",
						label: "Profile",
						kind: "select",
						options: ["first", "second"].map((value) => ({ value, label: value })),
					},
					{
						id: "project",
						label: "Project",
						kind: "select",
						options: [{ value: "one", label: "One" }],
						resetOn: ["profile"],
					},
					{
						id: "groups",
						label: "Groups",
						kind: "select",
						multiple: true,
						resetOn: ["project"],
						options: [{ value: "services", label: "Services", selectionValues: ["a"] }],
					},
					{
						id: "components",
						label: "Components",
						kind: "select",
						multiple: true,
						presetsFrom: "groups",
						resetOn: ["project"],
						options: [{ value: "a", label: "Component a" }],
					},
				],
			}),
		});
		await flush();
		const selected = () =>
			target.querySelectorAll("#test-launcher-form-components input:checked").length;
		expect(selected()).toBe(1);
		const profile = target.querySelector<HTMLSelectElement>("#test-launcher-form-profile");
		if (!profile) throw new Error("Missing profile selector");
		profile.value = "second";
		profile.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();
		expect(target.querySelector<HTMLSelectElement>("#test-launcher-form-project")?.value).toBe("");
		expect(target.querySelectorAll("#test-launcher-form-groups input:checked")).toHaveLength(0);
		expect(selected()).toBe(0);
	});
	it("keeps explicit additions and exclusions across overlapping presets and submits only the final selection", async () => {
		const { target, checkbox, selected } = selectionFixture();
		await flush();
		expect(selected()).toEqual(["Component a", "Component b"]);
		checkbox("components", "Component b").click();
		await flush();
		checkbox("groups", "Monitoring").click();
		await flush();
		expect(selected()).toEqual(["Component a", "Component c"]);
		checkbox("components", "Component d").click();
		await flush();
		checkbox("groups", "Services").click();
		await flush();
		expect(selected()).toEqual(["Component c", "Component d"]);
		checkbox("components", "Component b").click();
		await flush();
		checkbox("groups", "Monitoring").click();
		await flush();
		expect(selected()).toEqual(["Component b", "Component d"]);
		const search = target.querySelector<HTMLInputElement>('input[type="search"]');
		if (!search) throw new Error("Missing selection search");
		search.value = "Component a";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();
		expect(target.querySelector(".selection-count")?.textContent).toBe("2 selected");
		expect(selected()).toEqual([]);
		search.value = "";
		search.dispatchEvent(new Event("input", { bubbles: true }));
		await flush();
		expect(selected()).toEqual(["Component b", "Component d"]);
		await waitForValidation(target);
		target.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
		await flush();
		const input = vi.mocked(launchLauncher).mock.calls.at(-1)?.[2];
		if (!input) throw new Error("Missing launch input");
		expect(input.groups).toBe("");
		expect(new Set(String(input.components).split("\n"))).toEqual(new Set(["b", "d"]));
	});

	it.each([
		"d",
		"",
	])("preserves a saved explicit selection of %j instead of restoring defaults", async (components) => {
		const { target, checkbox, selected } = selectionFixture({
			project: "one",
			groups: "monitoring",
			components,
		});
		await flush();
		expect(selected()).toEqual(components ? ["Component d"] : []);
		checkbox("groups", "Services").click();
		await flush();
		expect(selected()).toEqual(components ? ["Component a", "Component d"] : ["Component a"]);
		checkbox("components", "Component a").click();
		await flush();
		expect(target.querySelector(".selection-count")?.textContent).toBe(
			components ? "1 selected" : "0 selected",
		);
	});

	it("expands legacy draft groups instead of the current default group's components", async () => {
		const { selected } = selectionFixture({ project: "one", groups: "monitoring" });
		await flush();
		expect(selected()).toEqual(["Component b", "Component c"]);
	});

	it("retains unavailable choices and edits through option failures", async () => {
		const { choices, checkbox, selected } = selectionFixture();
		await flush();
		vi.mocked(fetchLauncherOptions).mockResolvedValue({ ...choices, groups: [], components: [] });
		checkbox("components", "Component d").click();
		await flush();
		expect(selected()).toEqual([
			"Component a (unavailable)",
			"Component b (unavailable)",
			"Component d (unavailable)",
		]);
		vi.mocked(fetchLauncherOptions).mockRejectedValue(new Error("Offline"));
		checkbox("components", "Component b (unavailable)").click();
		await flush();
		expect(selected()).toEqual(["Component a (unavailable)", "Component d (unavailable)"]);
	});

	it("clears selections and overrides when project changes and ignores older option responses", async () => {
		const { target, choices, checkbox, selected } = selectionFixture();
		await flush();
		const older = Promise.withResolvers<typeof choices>();
		vi.mocked(fetchLauncherOptions).mockReturnValueOnce(older.promise);
		checkbox("components", "Component b").click();
		await flush();
		vi.mocked(fetchLauncherOptions).mockResolvedValue({
			...choices,
			groups: [{ value: "new", label: "New", selectionValues: ["b", "d"] }],
		});
		const project = target.querySelector<HTMLSelectElement>("#test-launcher-form-project");
		if (!project) throw new Error("Missing project selector");
		project.value = "two";
		project.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();
		expect(selected()).toEqual([]);
		older.resolve(choices);
		await flush();
		expect(selected()).toEqual([]);
		checkbox("groups", "New").click();
		await flush();
		expect(selected()).toEqual(["Component b", "Component d"]);
	});
});

describe("launcher validation while editing", () => {
	it("validates schedule edits against their pinned launch context", async () => {
		mountSubject({
			editingFutureLaunch: {
				id: "scheduled-launch",
				kind: "launch",
				scheduleKind: "once",
				processId: "test-process",
				launcherId: "test-launcher",
				launcherLabel: "Test launcher",
				nextRunAt: "2099-01-01T09:00:00.000Z",
				cronExpression: null,
				title: "Scheduled launch",
				subtitle: "Scheduled",
				launchTitle: null,
				launcherInput: {},
				skillIds: [],
				modelConfig: {},
			},
		});
		await flush();
		expect(vi.mocked(validateLauncher).mock.lastCall?.[1]).toMatchObject({
			futureExecutionId: "scheduled-launch",
		});
	});

	function required<T>(value: T | null | undefined): T {
		if (value == null) throw new Error("Missing test element or request");
		return value;
	}
	function button(target: HTMLElement) {
		return required(target.querySelector<HTMLButtonElement>('button[type="submit"]'));
	}
	function input(target: HTMLElement, id = "repoPath") {
		return required(target.querySelector<HTMLInputElement>(`#test-launcher-form-${id}`));
	}
	function edit(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
		field.value = value;
		field.dispatchEvent(new Event("input", { bubbles: true }));
	}

	it("keeps untouched errors quiet, validates typing, preserves unrelated errors and gates submission", async () => {
		vi.mocked(validateLauncher).mockImplementation(async (_id, request) =>
			request.launcherInput.repoPath === "/valid"
				? []
				: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
		);
		const { target } = mountSubject({ initialValues: { repoPath: "" } });
		await flush();
		expect(button(target).disabled).toBe(true);
		expect(input(target).getAttribute("aria-invalid")).toBe("false");
		expect(target.querySelector(".validation-status")?.textContent).toContain("Repo Path");

		input(target).focus();
		edit(input(target), "bad");
		await flush();
		expect(input(target).getAttribute("aria-invalid")).toBe("false");
		await waitForValidation(target);
		expect(input(target).getAttribute("aria-invalid")).toBe("true");
		expect(target.querySelector("#test-launcher-form-repoPath-errors")?.textContent).toContain(
			"Required.",
		);
		expect(document.activeElement).toBe(input(target));
		edit(input(target, "process-title"), "A title");
		await flush();
		expect(input(target).getAttribute("aria-invalid")).toBe("true");
		required(target.querySelector("form")).dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true }),
		);
		expect(launchLauncher).not.toHaveBeenCalled();

		edit(input(target), "/valid");
		await flush();
		expect(button(target).disabled).toBe(true);
		await waitForValidation(target);
		expect(button(target).disabled).toBe(false);
		expect(input(target).getAttribute("aria-invalid")).toBe("false");
		button(target).click();
		await flush();
		expect(launchLauncher).toHaveBeenCalledOnce();
	});

	it("debounces textarea edits without waiting for blur", async () => {
		const { target } = mountSubject({
			launcher: createLauncher({ fields: [{ id: "prompt", label: "Prompt", kind: "textarea" }] }),
		});
		await flush();
		vi.mocked(validateLauncher).mockClear();
		const prompt = required(target.querySelector("textarea"));
		prompt.focus();
		edit(prompt, "one");
		await flush();
		edit(prompt, "two");
		await flush();
		expect(validateLauncher).not.toHaveBeenCalled();
		await waitForValidation(target);
		expect(validateLauncher).toHaveBeenCalledOnce();
		expect(vi.mocked(validateLauncher).mock.lastCall?.[1].launcherInput).toEqual({ prompt: "two" });
		expect(document.activeElement).toBe(prompt);
	});

	it("ignores obsolete responses, flushes on blur and aborts validation on unmount", async () => {
		const older = Promise.withResolvers<Awaited<ReturnType<typeof validateLauncher>>>();
		const newer = Promise.withResolvers<Awaited<ReturnType<typeof validateLauncher>>>();
		vi.mocked(validateLauncher)
			.mockReturnValueOnce(older.promise)
			.mockReturnValueOnce(newer.promise);
		const { target, dispose } = mountSubject();
		await flush();
		const olderSignal = required(vi.mocked(validateLauncher).mock.calls[0]?.[2]);
		edit(input(target), "new draft");
		input(target).dispatchEvent(new FocusEvent("blur"));
		await flush();
		expect(olderSignal.aborted).toBe(true);
		older.resolve([]);
		await flush();
		expect(button(target).disabled).toBe(true);
		newer.resolve([{ code: "custom", fieldId: "repoPath", message: "Unavailable repository" }]);
		await flush();
		expect(target.textContent).toContain("Unavailable repository");
		expect(button(target).disabled).toBe(true);

		const pending = Promise.withResolvers<Awaited<ReturnType<typeof validateLauncher>>>();
		vi.mocked(validateLauncher).mockReturnValueOnce(pending.promise);
		edit(input(target), "last draft");
		input(target).dispatchEvent(new FocusEvent("blur"));
		await flush();
		const signal = required(vi.mocked(validateLauncher).mock.lastCall?.[2]);
		await dispose();
		expect(signal.aborted).toBe(true);
		pending.resolve([]);
	});

	it("keeps values on validation failure and enables launch after Retry succeeds", async () => {
		vi.mocked(validateLauncher).mockRejectedValueOnce(new Error("Validation is unavailable"));
		const { target } = mountSubject({ initialValues: { repoPath: "/saved-draft" } });
		await flush();
		expect(button(target).disabled).toBe(true);
		expect(input(target).value).toBe("/saved-draft");
		expect(target.textContent).toContain("Validation is unavailable");
		required(
			Array.from(target.querySelectorAll("button")).find(
				(b) => b.textContent === "Retry validation",
			),
		).click();
		await flush();
		expect(button(target).disabled).toBe(false);
	});

	it("shows unknown field errors at form level instead of hiding launch blockers", async () => {
		vi.mocked(validateLauncher).mockResolvedValue([
			{ code: "custom", fieldId: "missing-control", message: "Repository settings need attention" },
		]);
		const { target } = mountSubject();
		await flush();
		expect(target.querySelector(".form-error-banner")?.textContent).toContain(
			"Repository settings need attention",
		);
		expect(button(target).disabled).toBe(true);
	});

	it("marks checkbox groups invalid and validates the updated selection", async () => {
		vi.mocked(fetchLauncherOptions).mockResolvedValue({ groups: [{ value: "one", label: "One" }] });
		vi.mocked(validateLauncher).mockImplementation(async (_id, request) =>
			request.launcherInput.groups
				? []
				: [{ code: "required", fieldId: "groups", message: "groups is required" }],
		);
		const { target } = mountSubject({
			launcher: createLauncher({
				fields: [{ id: "groups", label: "Groups", kind: "select", multiple: true, required: true }],
			}),
		});
		await flush();
		const checkbox = required(
			target.querySelector<HTMLInputElement>('.multi-select-control input[type="checkbox"]'),
		);
		checkbox.click();
		await flush();
		expect(button(target).disabled).toBe(false);
		checkbox.click();
		await flush();
		const group = required(target.querySelector(".multi-select-control"));
		expect(group.getAttribute("data-invalid")).toBe("true");
		expect(group.getAttribute("aria-describedby")).toContain("groups-errors");
		expect(button(target).disabled).toBe(true);
	});

	it("places model and schedule errors next to their controls", async () => {
		vi.mocked(validateLauncher).mockImplementation(async (_id, request) =>
			request.schedule.mode === "cron"
				? [{ code: "invalid_schedule", message: "Enter a valid cron expression" }]
				: request.modelConfig.defaultModelProfileId
					? [{ code: "invalid_model_config", message: "This model is unavailable" }]
					: [],
		);
		const { target } = mountSubject();
		await flush();
		const model = required(target.querySelector<HTMLSelectElement>(".model-config-default-select"));
		model.value = "local_qwen";
		model.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();
		expect(model.getAttribute("aria-invalid")).toBe("true");
		expect(target.querySelector("#test-launcher-form-model-config-errors")?.textContent).toContain(
			"This model is unavailable",
		);
		required(
			target.querySelectorAll<HTMLInputElement>(
				'input[name="test-launcher-form-schedule-mode"]',
			)[2],
		).click();
		await flush();
		expect(input(target, "schedule-cron").getAttribute("aria-invalid")).toBe("true");
		expect(target.querySelector("#test-launcher-form-schedule-cron-errors")?.textContent).toContain(
			"Enter a valid cron expression",
		);
		expect(button(target).disabled).toBe(true);
	});
});
