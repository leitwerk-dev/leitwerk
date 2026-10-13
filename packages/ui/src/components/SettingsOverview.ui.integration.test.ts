import type { SettingsScopesResponse } from "@leitwerk-dev/protocol/http-contracts";
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, it, vi } from "vitest";
import { navigate } from "../lib/router.svelte.js";
import { fetchSettingsOverview } from "../lib/settings.js";
import SettingsOverview from "./SettingsOverview.svelte";

vi.mock("../lib/settings.js", async (original) => ({
	...(await original<typeof import("../lib/settings.js")>()),
	fetchSettingsOverview: vi.fn(),
}));
let app: ReturnType<typeof mount>;
const subjects = ["Catalog", "Portal", "Unavailable"].map((name, i) => ({
	id: `component-${i}`,
	label: `DEMO / ${name}`,
	scopeType: "settings-test.component",
	active: true,
	hasSettings: true,
})) as SettingsScopesResponse["subjects"];
function button(name: string) {
	const found = [...document.querySelectorAll("button")].find((b) =>
		b.textContent?.trim().startsWith(name),
	);
	if (!found) throw Error(name);
	return found;
}
afterEach(async () => {
	if (app) await unmount(app);
	document.body.innerHTML = "";
	vi.resetAllMocks();
	navigate("/settings");
});
it("filters effective mappings, searches repository labels, and keeps resolution errors out of unmapped", async () => {
	navigate("/settings?scope=component-0&view=overview");
	vi.mocked(fetchSettingsOverview).mockResolvedValue({
		items: [
			{
				subjectId: "component-0",
				customized: [],
				mapping: [{ value: "catalog-repository", label: "example/catalog · primary / HTTPS" }],
				errors: [],
			},
			{ subjectId: "component-1", customized: [], mapping: [], errors: [] },
			{ subjectId: "component-2", customized: [], mapping: [], errors: ["Invalid mapping"] },
		],
	});
	app = mount(SettingsOverview, {
		target: document.body,
		props: {
			scopeType: "settings-test.component",
			label: "Components",
			overview: {
				itemLabel: "Component",
				itemLabelPlural: "Components",
				parentLabel: "Project",
				labelSeparator: " / ",
			},
			subjects,
			selected: "component-0",
			panelOpen: false,
			onSelect: vi.fn(),
			onClose: vi.fn(),
		},
	});
	await vi.waitFor(() => expect(document.body.textContent).toContain("1 of 3 components mapped"));
	button("Unmapped").click();
	await tick();
	expect([...document.querySelectorAll("tbody tr")].map((row) => row.textContent)).toEqual([
		expect.stringContaining("Portal"),
	]);
	expect(location.search).toContain("filter=unmapped");
	button("All").click();
	await tick();
	const search = document.querySelector<HTMLInputElement>('input[type="search"]');
	if (!search) throw Error("Missing search input");
	search.value = "example/catalog";
	search.dispatchEvent(new Event("input", { bubbles: true }));
	await tick();
	expect(document.querySelectorAll("tbody tr")).toHaveLength(1);
	expect(document.querySelector("tbody")?.textContent).toContain("Catalog");
	expect(location.search).toContain("q=example%2Fcatalog");
	window.dispatchEvent(new Event("leitwerk:settings-changed"));
	await vi.waitFor(() => expect(fetchSettingsOverview).toHaveBeenCalledTimes(2));
	expect(search.value).toBe("example/catalog");
});
it("uses default/customized filters for repository and other scopes without mapping metadata", async () => {
	navigate("/settings?scope=component-0&view=overview&filter=defaults");
	vi.mocked(fetchSettingsOverview).mockResolvedValue({
		items: [
			{ subjectId: "component-0", customized: ["Planning model"], errors: [] },
			{ subjectId: "component-1", customized: [], errors: [] },
			{ subjectId: "component-2", customized: [], errors: ["Model unavailable"] },
		],
	});
	app = mount(SettingsOverview, {
		target: document.body,
		props: {
			scopeType: "repository",
			label: "Repositories",
			subjects,
			selected: "component-0",
			panelOpen: false,
			onSelect: vi.fn(),
			onClose: vi.fn(),
		},
	});
	await vi.waitFor(() => expect(document.querySelectorAll("tbody tr")).toHaveLength(1));
	expect(document.querySelector("tbody")?.textContent).toContain("DEMO / Portal");
	button("Customized").click();
	await tick();
	expect(document.querySelector("tbody")?.textContent).toContain("Planning model");
	expect(document.querySelector("tbody")?.textContent).not.toContain("Unavailable");
});
