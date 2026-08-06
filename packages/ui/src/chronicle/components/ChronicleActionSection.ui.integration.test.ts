/// <reference types="svelte" />
import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ProcessActionModelPreview,
	ProcessActionSummary,
	ProcessModelConfigurationView,
} from "../../lib/api.js";
import type { ActionSectionController } from "../lib/action-bindings.js";
import ChronicleActionSection from "./ChronicleActionSection.svelte";

function createAction(overrides: Partial<ProcessActionSummary> = {}): ProcessActionSummary {
	return {
		id: "request_revision",
		label: "Request revision",
		description: "Send the latest feedback back to the worker",
		preview: {
			kind: "turn",
			turnId: "draft_poem",
			turnKind: "llm",
			description: "Draft the next revision",
		},
		supportsScheduling: true,
		supportsNextTurnModelOverride: true,
		form: {
			id: "request_revision_form",
			title: "Request revision",
			fields: [{ id: "notes", label: "Notes", kind: "textarea", required: true }],
		},
		...overrides,
	};
}

function createModelConfiguration(
	overrides: Partial<ProcessModelConfigurationView> = {},
): ProcessModelConfigurationView {
	return {
		availableProfiles: [
			{
				id: "claude-sonnet-4",
				label: "claude-sonnet-4 — Claude Sonnet 4",
				description: "Balanced model",
				availability: "available",
			},
			{
				id: "gpt-5-mini",
				label: "gpt-5-mini — GPT-5 Mini",
				description: "Fast model",
				availability: "available",
			},
		],
		effectiveSelectedTurn: null,
		defaultModel: {
			processConfigModelProfileId: null,
			instanceModelProfileId: null,
			effectiveModelProfileId: null,
			source: "none",
		},
		turns: [],
		...overrides,
	};
}

function createModelPreview(
	overrides: Partial<ProcessActionModelPreview> = {},
): ProcessActionModelPreview {
	return {
		kind: "llm_turn",
		turnId: "draft_poem",
		description: "Draft the next revision",
		resolvedModel: {
			status: "resolved",
			modelProfileId: "claude-sonnet-4",
			source: "instance_default",
			error: null,
		},
		warmPromptCache: {
			previousModelProfileId: "claude-sonnet-4",
			compatibleModelProfileIds: ["claude-sonnet-4"],
			expiresAt: "2099-01-01T00:00:00.000Z",
		},
		...overrides,
	};
}

function mountSubject(
	input: {
		initialValue?: string;
		actionOverrides?: Partial<ProcessActionSummary>;
		selectedModelOverrideValue?: string;
		modelConfiguration?: ProcessModelConfigurationView;
		modelPreview?: ProcessActionModelPreview | null;
		modelPreviewLoading?: boolean;
	} = {},
) {
	const values: Record<string, Record<string, string | number | boolean>> = {
		request_revision: {
			notes: input.initialValue ?? "",
		},
	};
	const target = document.createElement("div");
	document.body.appendChild(target);
	const scheduledAtParts: Record<string, { date: string; hour: string; minute: string }> = {};
	const onRunAction = vi.fn();
	const onExpandActionForm = vi.fn();
	const actionBindings: ActionSectionController = {
		actionSectionActions: [createAction(input.actionOverrides)],
		openActionModelPreview:
			input.modelPreview === undefined ? createModelPreview() : input.modelPreview,
		openActionModelPreviewLoading: input.modelPreviewLoading ?? false,
		actionBusyId: null,
		actionError: null,
		selectedActionId: "request_revision",
		openActionFormId: "request_revision",
		actionFieldDomId: (actionId: string, fieldId: string) => `${actionId}__${fieldId}`,
		getActionFieldValue: (actionId, field) => values[actionId]?.[field.id] ?? "",
		setActionFieldValue: (actionId, field, value) => {
			values[actionId] = {
				...(values[actionId] ?? {}),
				[field.id]: value,
			};
		},
		commitActionPreview: vi.fn(),
		getActionModelOverrideValue: () => input.selectedModelOverrideValue ?? "",
		setActionModelOverrideValue: vi.fn(),
		getActionScheduleMode: () => "now",
		setActionScheduleMode: vi.fn(),
		getActionScheduledAtLocalParts: (actionId) =>
			scheduledAtParts[actionId] ?? { date: "", hour: "", minute: "" },
		setActionScheduledAtLocalParts: (actionId, value) => {
			scheduledAtParts[actionId] = {
				...(scheduledAtParts[actionId] ?? { date: "", hour: "", minute: "" }),
				...value,
			};
		},
		selectAction: vi.fn(),
		expandActionForm: onExpandActionForm,
		collapseActionForm: vi.fn(),
		submitActionDecision: onRunAction,
	};
	const app = mount(ChronicleActionSection, {
		target,
		props: {
			anchorId: "action-anchor",
			isFocused: true,
			actionSectionController: actionBindings,
			externalTriggers: [],
			externalTriggerSignals: [],
			selectedTurn: null,
			modelConfiguration: input.modelConfiguration ?? createModelConfiguration(),
		},
		context: new Map(),
	});
	return {
		app,
		target,
		onRunAction,
		onExpandActionForm,
		values,
	};
}

beforeEach(() => {
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("ChronicleActionSection", () => {
	it("expands the exact inline action through the canonical transition", async () => {
		const { app, target, onExpandActionForm } = mountSubject();

		target.querySelector<HTMLButtonElement>('[data-action-id="request_revision"]')?.click();

		expect(onExpandActionForm).toHaveBeenCalledWith("request_revision");
		await unmount(app);
	});

	it("hides the model override selector unless the action can select an llm turn", async () => {
		const { app, target } = mountSubject({
			actionOverrides: {
				preview: {
					kind: "terminal",
					turnId: null,
					turnKind: null,
					description: "Complete process",
				},
				supportsNextTurnModelOverride: false,
			},
			modelPreview: null,
		});

		expect(target.querySelector('select[id$="__next-turn-model-profile"]')).toBeNull();
		unmount(app);
	});

	it("hides the override and submits when the preview is not applicable", async () => {
		const { app, target, onRunAction } = mountSubject({
			initialValue: "Please tighten the rollout summary.",
			selectedModelOverrideValue: "gpt-5-mini",
			modelPreview: {
				kind: "not_applicable",
				turnId: null,
				description: null,
			},
		});

		await Promise.resolve();
		await Promise.resolve();

		expect(target.querySelector('select[id$="__next-turn-model-profile"]')).toBeNull();
		(target.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.click();
		await Promise.resolve();
		await Promise.resolve();

		expect(onRunAction).toHaveBeenCalledWith(
			expect.objectContaining({ supportsNextTurnModelOverride: true }),
		);
		unmount(app);
	});

	it("shows the resolved model helper for the blank option", async () => {
		const { app, target } = mountSubject();

		await Promise.resolve();
		await Promise.resolve();

		const select = target.querySelector<HTMLSelectElement>(
			'select[id$="__next-turn-model-profile"]',
		);
		const helper = target.querySelector<HTMLElement>('[data-section="action-model-helper"]');
		expect(select?.options[0]?.textContent).toContain("claude-sonnet-4");
		expect(helper?.textContent).toContain("claude-sonnet-4");
		expect(helper?.dataset.tone).toBe("muted");
		unmount(app);
	});

	it("shows a non-blocking warning for cache-sensitive model switches", async () => {
		const { app, target } = mountSubject({ selectedModelOverrideValue: "gpt-5-mini" });

		await Promise.resolve();
		await Promise.resolve();

		expect(target.querySelector('[data-section="action-model-switch-warning"]')).toBeTruthy();
		unmount(app);
	});

	it("suppresses the warning for explicit same-model picks and root-start turns", async () => {
		const sameModel = mountSubject({ selectedModelOverrideValue: "claude-sonnet-4" });
		const rootStart = mountSubject({
			selectedModelOverrideValue: "gpt-5-mini",
			modelPreview: createModelPreview({ warmPromptCache: undefined }),
		});

		await Promise.resolve();
		await Promise.resolve();

		expect(
			sameModel.target.querySelector('[data-section="action-model-switch-warning"]'),
		).toBeNull();
		expect(
			rootStart.target.querySelector('[data-section="action-model-switch-warning"]'),
		).toBeNull();
		unmount(sameModel.app);
		unmount(rootStart.app);
	});

	it("shows inline model-resolution errors", async () => {
		const { app, target } = mountSubject({
			modelPreview: createModelPreview({
				resolvedModel: {
					status: "error",
					modelProfileId: null,
					source: null,
					error: "resolver exploded",
				},
			}),
		});

		await Promise.resolve();
		await Promise.resolve();

		const helper = target.querySelector<HTMLElement>('[data-section="action-model-helper"]');
		expect(helper?.dataset.tone).toBe("error");
		expect(helper?.textContent).toContain("resolver exploded");
		unmount(app);
	});

	it("shows a loading note when the preview is still refreshing", async () => {
		const { app, target } = mountSubject({
			modelPreview: null,
			modelPreviewLoading: true,
		});

		await Promise.resolve();
		await Promise.resolve();

		expect(target.querySelector('[data-section="action-model-loading"]')).toBeTruthy();
		unmount(app);
	});
});
