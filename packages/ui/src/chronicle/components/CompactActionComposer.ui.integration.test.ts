/// <reference types="svelte" />
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessActionSummary } from "../../lib/api.js";
import type { ActionSectionController } from "../lib/action-bindings.js";
import CompactActionComposer from "./CompactActionComposer.svelte";

const approveAction: ProcessActionSummary = {
	id: "approve_plan",
	label: "Approve plan",
	description: "Approve the current plan and continue.",
	supportsScheduling: false,
	supportsNextTurnModelOverride: false,
};

const revisionAction: ProcessActionSummary = {
	id: "request_revision",
	label: "Request revision",
	description: "Send the plan back for another revision.",
	supportsScheduling: true,
	supportsNextTurnModelOverride: true,
	form: {
		id: "request_revision",
		title: "Request revision",
		fields: [
			{
				id: "message",
				label: "Revision notes",
				kind: "textarea",
				required: true,
				placeholder: "Describe what should change",
			},
		],
		submitLabel: "Request revision",
	},
};

const mountedApps: Array<ReturnType<typeof mount>> = [];

afterEach(async () => {
	for (const app of mountedApps.splice(0)) {
		await unmount(app);
	}
	document.body.innerHTML = "";
});

function mountSubject() {
	const values: Record<string, Record<string, string | number | boolean>> = {
		request_revision: { message: "" },
	};
	const submitActionDecision = vi.fn();
	const onOpenDetails = vi.fn();
	const controller: ActionSectionController = {
		actionSectionActions: [approveAction, revisionAction],
		openActionModelPreview: null,
		openActionModelPreviewLoading: false,
		actionBusyId: null,
		actionError: null,
		selectedActionId: "request_revision",
		openActionFormId: null,
		actionFieldDomId: (actionId, fieldId) => `${actionId}-${fieldId}`,
		getActionFieldValue: (actionId, field) => values[actionId]?.[field.id] ?? "",
		setActionFieldValue: (actionId, field, value) => {
			values[actionId] = { ...(values[actionId] ?? {}), [field.id]: value };
		},
		commitActionPreview: vi.fn(),
		getActionModelOverrideValue: () => "",
		setActionModelOverrideValue: vi.fn(),
		getActionScheduleMode: () => "now",
		setActionScheduleMode: vi.fn(),
		getActionScheduledAtLocalParts: () => ({ date: "", hour: "", minute: "" }),
		setActionScheduledAtLocalParts: vi.fn(),
		selectAction: vi.fn(),
		expandActionForm: vi.fn(),
		collapseActionForm: vi.fn(),
		submitActionDecision,
	};
	const target = document.createElement("div");
	document.body.appendChild(target);
	const app = mount(CompactActionComposer, {
		target,
		props: { actionSectionController: controller, onOpenDetails },
	});
	mountedApps.push(app);
	return { target, values, submitActionDecision, onOpenDetails, controller };
}

async function flushUi() {
	await tick();
	await Promise.resolve();
}

describe("CompactActionComposer", () => {
	it("starts with the feedback action and submits the shared draft with default runtime options", async () => {
		const { target, values, submitActionDecision } = mountSubject();
		await flushUi();

		const actionChoice = target.querySelector<HTMLSelectElement>("#compact-action-choice");
		const textarea = target.querySelector<HTMLTextAreaElement>("textarea");
		expect(actionChoice?.value).toBe("request_revision");
		expect(textarea?.placeholder).toBe("Describe what should change");

		if (!textarea) throw new Error("Expected the compact feedback field");
		textarea.value = "Keep the first phase smaller.";
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
		target
			.querySelector<HTMLFormElement>("form")
			?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await flushUi();

		expect(values.request_revision?.message).toBe("Keep the first phase smaller.");
		expect(submitActionDecision).toHaveBeenCalledWith(revisionAction);
	});

	it("keeps required feedback validation beside the plan", async () => {
		const { target, submitActionDecision } = mountSubject();
		await flushUi();

		target
			.querySelector<HTMLFormElement>("form")
			?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
		await flushUi();

		expect(target.querySelector('[role="alert"]')?.textContent).toContain(
			"Revision notes is required.",
		);
		expect(submitActionDecision).not.toHaveBeenCalled();
	});

	it("routes selection through the canonical controller", async () => {
		const { target, controller } = mountSubject();
		await flushUi();

		const choice = target.querySelector<HTMLSelectElement>("#compact-action-choice");
		if (!choice) throw new Error("Expected action choice");
		choice.value = "approve_plan";
		choice.dispatchEvent(new Event("change", { bubbles: true }));

		expect(controller.selectAction).toHaveBeenCalledWith("approve_plan");
	});

	it("requests the canonical detailed form for scheduling and model selection", async () => {
		const { target, onOpenDetails } = mountSubject();
		await flushUi();

		target.querySelector<HTMLButtonElement>(".options-button")?.click();

		expect(onOpenDetails).toHaveBeenCalledWith("request_revision");
	});
});
