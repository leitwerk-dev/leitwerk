// @vitest-environment jsdom
import type { DashboardResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import { mount, unmount } from "svelte";
import { writable } from "svelte/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDashboard } from "../lib/api.js";
import DashboardPage from "./DashboardPage.svelte";

vi.mock("../lib/api.js", () => ({ fetchDashboard: vi.fn() }));
const connection = writable({ reconnectCount: 0 });
vi.mock("../lib/ws.svelte.js", () => ({
	wsStore: {
		subscribe: (run: (value: { reconnectCount: number }) => void) => connection.subscribe(run),
	},
}));
const apps: ReturnType<typeof mount>[] = [];
function fixture(): DashboardResponseBody {
	return {
		generatedAt: "2026-10-14T12:00:00Z",
		definitions: {
			total: 4,
			items: ["Zebra", "Alpha", "Delta", "Beta"].map((name) => ({ id: name, name })),
		},
		watchers: {
			total: 1,
			enabled: 1,
			items: [{ id: "watch", name: "Issue watcher", enabled: true }],
		},
		skills: { total: 8, installed: 3, bundled: 5 },
		processes: {
			total: 4,
			byStatus: [
				{ status: "running", count: 1 },
				{ status: "waiting", count: 2 },
				{ status: "completed", count: 1 },
			],
			byDefinition: [{ processId: "poem", name: "Poem creator", count: 4 }],
		},
		costs: {
			totalUsd: 1.5,
			totalLlmTurnCount: 8,
			pricedTurnCount: 7,
			missingCostTurnCount: 1,
			isPartial: true,
			byModel: Array.from({ length: 6 }, (_, index) => ({
				providerId: "Provider",
				modelId: `Model ${index}`,
				costUsd: 1 / (index + 1),
				turnCount: 1,
			})),
		},
		configuration: {
			issues: Array.from({ length: 4 }, (_, index) => ({
				id: `issue-${index}`,
				code: "missing",
				severity: index === 0 ? "error" : "warning",
				message: `Missing model ${index}`,
				sources: [
					{ label: "Model settings", href: "/settings" },
					{ label: "Configured default", href: null },
				],
			})),
		},
	};
}
async function flush() {
	for (let index = 0; index < 8; index++) await Promise.resolve();
	await new Promise((done) => setTimeout(done, 0));
}
async function render(data = fixture()) {
	vi.mocked(fetchDashboard).mockResolvedValue(data);
	const target = document.createElement("div");
	document.body.appendChild(target);
	apps.push(mount(DashboardPage, { target }));
	await flush();
	return target;
}
function button(target: HTMLElement, text: string) {
	const result = [...target.querySelectorAll("button")].find(
		(item) => item.textContent?.trim() === text,
	);
	expect(result).toBeDefined();
	return result as HTMLButtonElement;
}
beforeEach(() => {
	connection.set({ reconnectCount: 0 });
});
afterEach(async () => {
	for (const app of apps.splice(0)) await unmount(app);
	document.body.innerHTML = "";
	vi.clearAllMocks();
	vi.useRealTimers();
});

describe("DashboardPage", () => {
	it("summarizes catalogs with sorted previews and working destinations", async () => {
		const target = await render();
		const catalogs = target.querySelectorAll(".catalog");
		expect([...catalogs[0].querySelectorAll("li")].map((item) => item.textContent)).toEqual([
			"Alpha",
			"Beta",
			"Delta",
		]);
		expect(catalogs[0].textContent).toContain("+1 more");
		expect(catalogs[0].getAttribute("href")).toBe("/processes/new");
		expect(catalogs[1].getAttribute("href")).toBe("/watchers");
		expect(catalogs[1].textContent).toContain("1 enabled");
		expect(catalogs[2].getAttribute("href")).toBe("/skills");
		expect(catalogs[2].textContent).toMatch(/Installed\s*3/);
		expect(target.querySelector('a[href="/processes"]')?.textContent).toBe("View processes");
	});
	it("switches process grouping and expands costs and actionable issues", async () => {
		const target = await render();
		expect(target.textContent).toMatch(/Waiting\s*2/);
		button(target, "By definition").click();
		await flush();
		expect(target.querySelector(".ranked")?.textContent).toMatch(/Poem creator\s*4/);
		expect(button(target, "By definition").getAttribute("aria-pressed")).toBe("true");
		expect(target.textContent).toContain("Partial coverage: 7 of 8");
		expect(target.textContent).not.toContain("Model 5");
		button(target, "Show all 6 models").click();
		await flush();
		expect(target.textContent).toContain("Model 5");
		expect(target.textContent).not.toContain("Missing model 3");
		button(target, "Show all 4 issues").click();
		await flush();
		expect(target.textContent).toContain("Missing model 3");
		expect(target.querySelector(".sources a")?.getAttribute("href")).toBe("/settings");
	});
	it("renders explicit empty and healthy states", async () => {
		const data = fixture();
		data.processes.total = 0;
		data.configuration.issues = [];
		data.costs.totalLlmTurnCount = 0;
		const target = await render(data);
		expect(target.textContent).toContain("No processes yet");
		expect(target.textContent).toContain("No LLM usage recorded yet");
		expect(target.textContent).toContain("No model readiness issues detected");
	});
	it.each([null, 0])("distinguishes cost availability for %s", async (totalUsd) => {
		const data = fixture();
		data.costs.totalUsd = totalUsd;
		const target = await render(data);
		expect(target.textContent).toContain(
			totalUsd === null ? "Cost unavailable" : "zero estimated cost",
		);
	});
	it("retains snapshots on refresh failure and recovers with Retry", async () => {
		const target = await render();
		vi.mocked(fetchDashboard).mockRejectedValueOnce(new Error("offline"));
		button(target, "Refresh").click();
		await flush();
		expect(target.textContent).toContain("Showing the last loaded overview");
		expect(target.textContent).toContain("Issue watcher");
		button(target, "Retry").click();
		await flush();
		expect(target.querySelector('[role="alert"]')).toBeNull();
	});
	it("refreshes on reconnect and visible-tab recovery and cleans up on unmount", async () => {
		await render();
		expect(fetchDashboard).toHaveBeenCalledTimes(1);
		connection.set({ reconnectCount: 1 });
		await flush();
		expect(fetchDashboard).toHaveBeenCalledTimes(2);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		document.dispatchEvent(new Event("visibilitychange"));
		await flush();
		expect(fetchDashboard).toHaveBeenCalledTimes(3);
		const app = apps.pop();
		if (!app) throw new Error("Dashboard was not mounted");
		await unmount(app);
		connection.set({ reconnectCount: 2 });
		document.dispatchEvent(new Event("visibilitychange"));
		await flush();
		expect(fetchDashboard).toHaveBeenCalledTimes(3);
	});
	it("polls every 30 seconds only while visible", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		await render();
		await vi.advanceTimersByTimeAsync(30_000);
		await flush();
		expect(fetchDashboard).toHaveBeenCalledTimes(2);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		await vi.advanceTimersByTimeAsync(60_000);
		await flush();
		expect(fetchDashboard).toHaveBeenCalledTimes(2);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	});
	it("provides recovery when the initial snapshot fails", async () => {
		vi.mocked(fetchDashboard).mockRejectedValueOnce(new Error("offline"));
		const target = await render();
		expect(target.querySelector('[role="alert"]')).not.toBeNull();
		expect(target.querySelector(".catalog")).toBeNull();
		button(target, "Retry").click();
		await flush();
		expect(target.querySelector(".catalog")).not.toBeNull();
	});
});
