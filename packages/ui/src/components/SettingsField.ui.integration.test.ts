import type { SettingFieldView, SettingsPreview } from "@leitwerk-dev/protocol/http-contracts";
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import {
	changeSettings,
	fetchSettingsChoices,
	fetchSettingsPreview,
	SettingsRequestError,
} from "../lib/settings.js";
import SettingsField from "./SettingsField.svelte";

vi.mock("../lib/settings.js", async (original) => ({
	...(await original<typeof import("../lib/settings.js")>()),
	fetchSettingsChoices: vi.fn(),
	changeSettings: vi.fn(),
	fetchSettingsPreview: vi.fn(),
}));
const apps: ReturnType<typeof mount>[] = [];
const field: SettingFieldView = {
	key: "test.repositories",
	owner: "test",
	schemaVersion: 1,
	scopes: ["test.component"],
	merge: "replace",
	form: { label: "Repositories", group: "Repository mapping", control: "multiselect" },
	choices: [],
	choicesDeferred: true,
	effective: { key: "test.repositories", value: [], sources: [] },
	inherited: null,
	override: null,
	error: null,
};
async function render(
	configured = field,
	editing = true,
	onSaved: (preview: SettingsPreview) => void = () => {},
) {
	const target = document.createElement("div");
	document.body.append(target);
	apps.push(
		mount(SettingsField, {
			target,
			props: { field: configured, subjectId: "component", onSaved },
		}),
	);
	await tick();
	if (!editing) return;
	const edit = document.querySelector<HTMLButtonElement>("button");
	if (!edit) throw new Error("Missing override control");
	edit.click();
	await tick();
}
afterEach(async () => {
	for (const app of apps.splice(0)) await unmount(app);
	document.body.innerHTML = "";
	vi.resetAllMocks();
	vi.useRealTimers();
});

it("shows saved choices immediately and searches only after the minimum query, retaining selections when cleared", async () => {
	vi.useFakeTimers();
	vi.mocked(fetchSettingsChoices).mockResolvedValue({
		choices: [{ value: "other", label: "Other repository" }],
	});
	const configured: SettingFieldView = {
		...field,
		form: { ...field.form, search: { minimumLength: 2, placeholder: "Search repositories" } },
		effective: { key: field.key, sources: [], value: ["saved"] },
		choices: [{ value: "saved", label: "Saved repository" }],
	};
	await render(configured, false);
	await vi.advanceTimersByTimeAsync(250);
	expect(fetchSettingsChoices).not.toHaveBeenCalled();
	expect(document.querySelector(".effective")?.textContent).toContain("Saved repository");
	document.querySelector<HTMLButtonElement>("button")?.click();
	await tick();
	const input = document.querySelector<HTMLInputElement>('input[type="search"]');
	if (!input) throw new Error("Missing repository search");
	await vi.waitFor(() => expect(document.activeElement).toBe(input));
	expect(document.body.textContent).toContain("Type at least 2 characters");
	input.value = "o";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
	await vi.advanceTimersByTimeAsync(250);
	expect(fetchSettingsChoices).not.toHaveBeenCalled();
	input.value = " metadata ";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
	await vi.advanceTimersByTimeAsync(250);
	await tick();
	expect(fetchSettingsChoices).toHaveBeenCalledTimes(1);
	expect(fetchSettingsChoices).toHaveBeenLastCalledWith(
		"component",
		field.key,
		"metadata",
		expect.any(AbortSignal),
	);
	expect(document.body.textContent).toContain("Other repository");
	expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
	input.value = "";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
	await vi.advanceTimersByTimeAsync(250);
	expect(fetchSettingsChoices).toHaveBeenCalledTimes(1);
	expect(document.body.textContent).not.toContain("Other repository");
	expect(document.body.textContent).toContain("Saved repository");
});

it("discards a pending search response after the operator clears the query", async () => {
	vi.useFakeTimers();
	const pending = Promise.withResolvers<{ choices: { value: string; label: string }[] }>();
	vi.mocked(fetchSettingsChoices).mockReturnValue(pending.promise);
	await render({ ...field, form: { ...field.form, search: { minimumLength: 2 } } });
	const input = document.querySelector<HTMLInputElement>('input[type="search"]');
	if (!input) throw new Error("Missing repository search");
	input.value = "query";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
	await vi.advanceTimersByTimeAsync(250);
	expect(document.body.textContent).toContain("Searching");
	input.value = "";
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
	pending.resolve({ choices: [{ value: "stale", label: "Stale repository" }] });
	await vi.advanceTimersByTimeAsync(250);
	await tick();
	expect(document.body.textContent).not.toContain("Stale repository");
	expect(document.body.textContent).not.toContain("Searching");
});

it("keeps the field usable while options load and retains draft selections across searches", async () => {
	const pending = Promise.withResolvers<{ choices: { value: string; label: string }[] }>();
	vi.mocked(fetchSettingsChoices)
		.mockReturnValueOnce(pending.promise)
		.mockResolvedValue({ choices: [{ value: "other", label: "Other repository" }] });
	await render();
	expect(document.querySelector(".effective")?.textContent).toContain("None selected");
	expect(document.querySelector('input[type="search"]')).not.toBeNull();
	await vi.waitFor(() => expect(fetchSettingsChoices).toHaveBeenCalledTimes(1));
	expect(document.body.textContent).toContain("Loading options");
	pending.resolve({ choices: [{ value: "retained", label: "Chosen repository" }] });
	await vi.waitFor(() => expect(document.body.textContent).toContain("Chosen repository"));
	const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
	if (!checkbox) throw new Error("Missing repository option");
	checkbox.checked = true;
	checkbox.dispatchEvent(new Event("change", { bubbles: true }));
	const search = document.querySelector<HTMLInputElement>('input[type="search"]');
	if (!search) throw new Error("Missing options search");
	search.value = "other";
	search.dispatchEvent(new Event("input", { bubbles: true }));
	await vi.waitFor(() => expect(document.body.textContent).toContain("Other repository"));
	expect(document.body.textContent).toContain("Chosen repository");
	expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
	expect(fetchSettingsChoices).toHaveBeenLastCalledWith(
		"component",
		field.key,
		"other",
		expect.any(AbortSignal),
	);
});

it("reports option failures inline and retries without closing the editor", async () => {
	vi.mocked(fetchSettingsChoices)
		.mockRejectedValueOnce(new Error("Repository search unavailable"))
		.mockResolvedValue({ choices: [{ value: "repo", label: "Repository" }] });
	await render();
	await vi.waitFor(() =>
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Repository search unavailable",
		),
	);
	const retry = [...document.querySelectorAll("button")].find(
		(button) => button.textContent === "Retry options",
	);
	if (!retry) throw new Error("Missing options retry");
	retry.click();
	await vi.waitFor(() => expect(document.body.textContent).toContain("Repository"));
	await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull());
	expect(document.querySelector('input[type="search"]')).not.toBeNull();
});

it("edits one named list, preserves draft names and unavailable members through conflicts and search failures", async () => {
	const groups: SettingFieldView = {
		...field,
		form: {
			label: "Component groups",
			group: "Investigation",
			control: "named-selection-list",
			search: { minimumLength: 2 },
		},
		effective: {
			key: field.key,
			value: [{ id: "services", name: "Services", values: ["retained", "missing"] }],
			sources: [],
		},
		choices: [{ value: "retained", label: "Monitor init" }],
		override: {
			subjectId: "component",
			key: field.key,
			value: [{ id: "services", name: "Services", values: ["retained", "missing"] }],
			mode: "replace",
			revision: 1,
			schemaVersion: 1,
			reset: false,
		} as SettingFieldView["override"],
	};
	const latest = { ...groups, override: { ...groups.override!, revision: 2 } };
	const response = {
		subject: { id: "component" },
		fields: [latest],
		inactive: [],
	} as unknown as import("@leitwerk-dev/protocol/http-contracts").SettingsPreview;
	vi.mocked(changeSettings).mockImplementation(async (_change, preview) => {
		if (preview) return response;
		throw new SettingsRequestError("Setting changed; your draft is preserved", 409);
	});
	vi.mocked(fetchSettingsPreview).mockResolvedValue(response);
	vi.mocked(fetchSettingsChoices).mockRejectedValue(new Error("Provider unavailable"));
	await render(groups, true, (preview) => {
		groups.override = preview.fields[0].override;
	});
	expect(document.body.textContent).toContain("Monitor init");
	expect(document.body.textContent).toContain("missing (unavailable)");
	const name = document.querySelector<HTMLInputElement>(
		'.named-selections input:not([type="checkbox"])',
	)!;
	name.value = "Operator group";
	name.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
	const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
	search.value = "monitor";
	search.dispatchEvent(new Event("input", { bubbles: true }));
	await vi.waitFor(() => expect(document.body.textContent).toContain("Provider unavailable"));
	await vi.waitFor(() => expect(document.body.textContent).toContain("Group preview"));
	vi.mocked(fetchSettingsChoices).mockResolvedValue({ choices: [] });
	[...document.querySelectorAll<HTMLButtonElement>("button")]
		.find((button) => button.textContent === "Retry search")!
		.click();
	await vi.waitFor(() =>
		expect(document.body.textContent).toContain("No additional matches. Try a different search."),
	);
	document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
	await vi.waitFor(() =>
		expect(document.body.textContent).toContain("Keep draft and use latest revision"),
	);
	expect(name.value).toBe("Operator group");
	expect(
		[
			...document.querySelectorAll<HTMLInputElement>('.named-selections input[type="checkbox"]'),
		].filter((input) => input.checked),
	).toHaveLength(2);
	[...document.querySelectorAll<HTMLButtonElement>("button")]
		.find((button) => button.textContent === "Keep draft and use latest revision")!
		.click();
	await tick();
	vi.mocked(changeSettings).mockResolvedValue(response);
	document.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
	await vi.waitFor(() =>
		expect(changeSettings).toHaveBeenLastCalledWith(
			expect.objectContaining({
				expectedRevision: 2,
				value: [{ id: "services", name: "Operator group", values: ["retained", "missing"] }],
			}),
		),
	);
});
