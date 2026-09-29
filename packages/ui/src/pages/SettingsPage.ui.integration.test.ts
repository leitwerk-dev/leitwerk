import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import type { SettingsPreview } from "@leitwerk-dev/protocol/http-contracts";
import { mount, tick, unmount } from "svelte";
import type { Writable } from "svelte/store";
import { afterEach, expect, it, vi } from "vitest";
import { changeSettings, fetchSettingsPreview, fetchSettingsScopes } from "../lib/settings.js";
import { wsStore } from "../lib/ws.svelte.js";
import SettingsPage from "./SettingsPage.svelte";

vi.mock("../lib/settings.js", async (original) => ({
	...(await original<typeof import("../lib/settings.js")>()),
	changeSettings: vi.fn(),
	fetchSettingsPreview: vi.fn(),
	fetchSettingsScopes: vi.fn(),
}));
vi.mock("../lib/ws.svelte.js", async () => {
	const { writable } = await import("svelte/store");
	return { wsStore: writable({ reconnectCount: 0 }) };
});
const connection = wsStore as Writable<{ reconnectCount: number }>;
const key = "coding.repository_instructions";
const apps: ReturnType<typeof mount>[] = [];
function preview(id: string, revision = 0, value = `${id} saved`): SettingsPreview {
	const stamp = {
		createdAt: "2026-09-01T12:00:00Z",
		updatedAt: "2026-09-01T12:00:00Z",
		actor: ADMIN_ACTOR,
		schemaVersion: 1,
		revision,
	};
	return {
		subject: {
			...stamp,
			id,
			scopeType: id === "instance" ? "instance" : "repository",
			identity: id,
			label: id,
			context: {},
		},
		inactive: [],
		fields: [
			{
				key,
				owner: "coding",
				schemaVersion: 1,
				scopes: ["instance", "repository"],
				merge: "instructions",
				form: { label: "Repository instructions", group: "Instructions", control: "textarea" },
				choices: [],
				effective: {
					key,
					value,
					sources: [
						{
							subjectId: id,
							scopeType: "repository",
							label: id,
							revision,
							schemaVersion: 1,
							mode: "replace",
						},
					],
				},
				inherited: null,
				override: revision
					? { ...stamp, subjectId: id, key, value, mode: "replace", reset: false }
					: null,
				error: null,
			},
		],
	};
}
function button(label: string) {
	const element = [...document.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === label,
	);
	if (!element) throw new Error(`Missing button: ${label}`);
	return element;
}
async function edit(label: string, value: string) {
	button(label).click();
	await tick();
	const input = document.querySelector("textarea");
	if (!input) throw new Error("Missing instructions editor");
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
	return input;
}
async function render() {
	if (!vi.mocked(changeSettings).getMockImplementation())
		vi.mocked(changeSettings).mockImplementation(async (change) => preview(change.subjectId));
	vi.mocked(fetchSettingsScopes).mockResolvedValue({
		scopes: [],
		subjects: ["instance", "repo-b"].map((id) => ({ ...preview(id).subject, active: true })),
	});
	vi.mocked(fetchSettingsPreview).mockImplementation(async (id) =>
		preview(id, id === "repo-b" ? 1 : 0),
	);
	const target = document.createElement("div");
	document.body.append(target);
	apps.push(mount(SettingsPage, { target }));
	await vi.waitFor(() => expect(document.querySelector(".setting-field")).not.toBeNull());
}
afterEach(async () => {
	for (const app of apps.splice(0)) await unmount(app);
	document.body.innerHTML = "";
	vi.resetAllMocks();
	connection.set({ reconnectCount: 0 });
});

it("keeps a repository draft bound to its scope when an earlier Instance save finishes", async () => {
	const pending = Promise.withResolvers<SettingsPreview>();
	vi.mocked(changeSettings).mockImplementation(async (change, draft) => {
		if (!draft && change.subjectId === "instance") return pending.promise;
		return preview(change.subjectId, 2, String(change.value));
	});
	await render();
	await edit("Override", "Instance update");
	button("Save override").click();
	await tick();
	const scope = document.querySelector<HTMLSelectElement>("#settings-scope");
	if (!scope) throw new Error("Missing scope selector");
	scope.value = "repo-b";
	scope.dispatchEvent(new Event("change", { bubbles: true }));
	await vi.waitFor(() =>
		expect(document.querySelector(".effective")?.textContent).toContain("repo-b saved"),
	);
	const editor = await edit("Edit override", "Repository draft");
	vi.mocked(fetchSettingsPreview).mockReturnValue(new Promise(() => {}));
	pending.resolve(preview("instance", 1, "Instance update"));
	await vi.waitFor(() => expect(fetchSettingsPreview).toHaveBeenCalledTimes(3));
	expect(document.querySelector("textarea")).toBe(editor);
	expect(editor.value).toBe("Repository draft");
	expect(scope.value).toBe("repo-b");
	button("Save override").click();
	await tick();
	expect(
		vi
			.mocked(changeSettings)
			.mock.calls.filter(([, draft]) => !draft)
			.map(([change]) => change),
	).toEqual([
		expect.objectContaining({
			subjectId: "instance",
			value: "Instance update",
			expectedRevision: 0,
		}),
		expect.objectContaining({
			subjectId: "repo-b",
			value: "Repository draft",
			expectedRevision: 1,
		}),
	]);
});

it("reloads scopes and effective values after reconnect without replacing an open draft", async () => {
	await render();
	const editor = await edit("Override", "Unsaved draft");
	vi.mocked(fetchSettingsPreview).mockResolvedValue(
		preview("instance", 1, "Another operator's update"),
	);
	vi.mocked(fetchSettingsScopes).mockResolvedValue({
		scopes: [],
		subjects: ["instance", "new-repository"].map((id) => ({
			...preview(id).subject,
			active: true,
		})),
	});
	connection.set({ reconnectCount: 1 });
	await vi.waitFor(() =>
		expect(document.querySelector(".effective")?.textContent).toContain(
			"Another operator's update",
		),
	);
	expect(fetchSettingsScopes).toHaveBeenCalledTimes(2);
	expect(document.querySelector('option[value="new-repository"]')).not.toBeNull();
	expect(document.querySelector("textarea")).toBe(editor);
	expect(editor.value).toBe("Unsaved draft");
	vi.mocked(changeSettings).mockResolvedValue(preview("instance", 2, "Unsaved draft"));
	button("Save override").click();
	await tick();
	expect(changeSettings).toHaveBeenCalledWith(
		expect.objectContaining({ subjectId: "instance", value: "Unsaved draft", expectedRevision: 0 }),
	);
});
