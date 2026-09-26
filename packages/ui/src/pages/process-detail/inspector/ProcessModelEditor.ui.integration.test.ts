// @vitest-environment jsdom
import type { ProcessModelConfigurationView } from "@leitwerk-dev/protocol/http-contracts";
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ProcessDetailData, updateProcessModelConfig } from "../../../lib/api.js";
import { loadProcessDetail } from "../../../lib/processes.svelte.js";
import ProcessModelEditor from "./ProcessModelEditor.svelte";

vi.mock("../../../lib/api.js", () => ({ updateProcessModelConfig: vi.fn() }));
vi.mock("../../../lib/processes.svelte.js", () => ({ loadProcessDetail: vi.fn() }));
const apps: ReturnType<typeof mount>[] = [];
const configuration: ProcessModelConfigurationView = {
	state: { kind: "ready" },
	availableProfiles: ["first", "second"].map((id) => ({
		id,
		label: id,
		availability: "available",
	})),
	effectiveSelectedTurn: null,
	defaultModel: {
		instanceModelProfileId: null,
		processConfigModelProfileId: null,
		effectiveModelProfileId: "first",
		source: "catalog_default",
	},
	turns: [
		{
			turnId: "run",
			description: "Draft",
			pathType: "primary",
			instanceModelProfileId: null,
			processConfigModelProfileId: null,
			effectiveConfiguredModelProfileId: null,
			source: "default",
		},
		{
			turnId: "system",
			description: "System",
			pathType: "primary",
			instanceModelProfileId: null,
			processConfigModelProfileId: null,
			effectiveConfiguredModelProfileId: "first",
			fixedModelProfileId: "first",
			source: "default",
		},
	],
};
function render() {
	const target = document.createElement("div");
	document.body.append(target);
	apps.push(
		mount(ProcessModelEditor, {
			target,
			props: {
				detail: {
					process: {
						id: "instance",
						lifecycleStatus: "active",
						initialDefaultModelProfileId: "first",
					},
					modelConfiguration: configuration,
				} as ProcessDetailData,
			},
		}),
	);
	vi.mocked(updateProcessModelConfig).mockResolvedValue({ modelConfiguration: configuration });
	return target;
}
function button(target: HTMLElement, label: string) {
	const result = [...target.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === label,
	);
	if (!result) throw new Error(`Missing button ${label}`);
	return result;
}
async function choose(target: HTMLElement, id: string, value: string) {
	const select = target.querySelector<HTMLSelectElement>(`#${id}`);
	if (!select) throw new Error("Missing selector");
	select.value = value;
	select.dispatchEvent(new Event("change", { bubbles: true }));
	await vi.waitFor(() => expect(button(target, "Save changes").disabled).toBe(false));
}
afterEach(async () => {
	for (const app of apps.splice(0)) await unmount(app);
	document.body.innerHTML = "";
	vi.resetAllMocks();
});

describe("process model editor", () => {
	it("focuses native selectors, previews sparse edits, cancels, and announces a save", async () => {
		const target = render();
		button(target, "Edit models").click();
		await tick();
		await tick();
		expect(document.activeElement?.id).toBe("instance-default-model");
		expect(target.querySelector("#step-model-system")).toBeNull();
		expect(target.textContent).toContain("Fixed system model");
		await choose(target, "instance-default-model", "second");
		expect(updateProcessModelConfig).toHaveBeenLastCalledWith(
			"instance",
			{ defaultModelProfileId: "second" },
			true,
		);
		button(target, "Cancel").click();
		await tick();
		await tick();
		expect(document.activeElement).toBe(button(target, "Edit models"));
		button(target, "Edit models").click();
		await tick();
		expect(target.querySelector<HTMLSelectElement>("select")?.value).toBe("");
		await choose(target, "step-model-run", "second");
		button(target, "Save changes").click();
		await vi.waitFor(() => expect(target.textContent).toContain("Model settings saved"));
		expect(updateProcessModelConfig).toHaveBeenLastCalledWith("instance", {
			turnConfigs: { run: { modelProfileId: "second" } },
		});
		expect(loadProcessDetail).toHaveBeenCalledWith("instance");
	});
	it("retains failed drafts and disables duplicate submissions while saving", async () => {
		const target = render();
		button(target, "Edit models").click();
		await tick();
		await choose(target, "instance-default-model", "second");
		const pending = Promise.withResolvers<{ modelConfiguration: ProcessModelConfigurationView }>();
		vi.mocked(updateProcessModelConfig).mockReturnValueOnce(pending.promise);
		button(target, "Save changes").click();
		await tick();
		expect(button(target, "Saving…").disabled).toBe(true);
		expect(button(target, "Cancel").disabled).toBe(true);
		pending.reject(new Error("Save failed"));
		await vi.waitFor(() =>
			expect(target.querySelector('[role="alert"]')?.textContent).toBe("Save failed"),
		);
		expect(target.querySelector<HTMLSelectElement>("select")?.value).toBe("second");
		button(target, "Save changes").click();
		await vi.waitFor(() => expect(target.textContent).toContain("Model settings saved"));
	});
});
