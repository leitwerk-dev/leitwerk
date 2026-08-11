// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EMPTY_PROCESS_BROWSER_STATUS_COUNTS as EMPTY_COUNTS,
	readProcessBrowserView,
	writeProcessBrowserView,
} from "../lib/process-browser.js";
import ProcessesPage from "./ProcessesPage.svelte";

const mocks = vi.hoisted(() => {
	function createStore<T>(initial: T) {
		let value = initial;
		const subscribers = new Set<(value: T) => void>();
		return {
			subscribe(run: (value: T) => void) {
				run(value);
				subscribers.add(run);
				return () => subscribers.delete(run);
			},
			set(next: T) {
				value = next;
				for (const subscriber of subscribers) subscriber(value);
			},
		};
	}
	return {
		browseItemsStore: createStore([] as unknown[]),
		browseStateStore: createStore({
			loading: false,
			error: null as string | null,
			pagination: null as null | Record<string, unknown>,
			facets: null as null | Record<string, unknown>,
		}),
		loadProcessBrowse: vi.fn().mockResolvedValue(undefined),
		navigate: vi.fn(),
	};
});

vi.mock("../lib/processes.svelte", () => ({
	browseItems: mocks.browseItemsStore,
	browseState: mocks.browseStateStore,
	loadProcessBrowse: mocks.loadProcessBrowse,
}));

vi.mock("../lib/router.svelte", () => ({
	buildFutureLaunchPath: vi.fn((id: string) => `/future-launches/${id}`),
	buildProcessPath: vi.fn((id: string) => `/processes/${id}`),
	navigate: mocks.navigate,
}));

function makeRow(overrides: Record<string, unknown> = {}) {
	return {
		instanceId: "agt_1",
		processId: "local_shell_process",
		title: "Shell cleanup",
		subtitle: "local_shell_process · 0 components",
		selectedTurnId: "run_command",
		lifecycleStatus: "active",
		statusCategory: "active",
		projectCount: 0,
		externalId: null,
		externalLinkCount: 0,
		processDisplayName: "Local Shell",
		processTitle: "Shell cleanup",
		createdAt: "2026-01-01T10:00:00Z",
		updatedAt: "2026-01-01T11:00:00Z",
		closedAt: null,
		initialPromptPreview: "echo hello",
		...overrides,
	};
}

function makeFuture(overrides: Record<string, unknown> = {}) {
	return {
		id: "fut_1",
		kind: "launch",
		scheduleKind: "once",
		processId: "review_process",
		instanceId: null,
		nextRunAt: "2026-01-02T10:00:00Z",
		cronExpression: null,
		title: "Scheduled review",
		launcherId: "review-ui",
		launcherLabel: "Review",
		initialPromptPreview: "review the archive navigation",
		...overrides,
	};
}

const mountedApps: Array<ReturnType<typeof mount>> = [];

function setBrowseState(overrides: Record<string, unknown> = {}) {
	mocks.browseStateStore.set({
		loading: false,
		error: null,
		pagination: {
			limit: 100,
			offset: 0,
			total: 0,
			processTotal: 0,
			futureExecutionTotal: 0,
			hasMore: false,
		},
		facets: { statusCounts: EMPTY_COUNTS, processTypes: [] },
		...overrides,
	});
}

function resetMocks() {
	mocks.browseItemsStore.set([]);
	setBrowseState();
	vi.clearAllMocks();
	mocks.loadProcessBrowse.mockResolvedValue(undefined);
}

function mountSubject() {
	const target = document.createElement("div");
	document.body.appendChild(target);
	mountedApps.push(mount(ProcessesPage, { target }));
	return target;
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function itemIds(target: HTMLElement): string[] {
	return [...target.querySelectorAll<HTMLElement>("[data-process-browser-row]")].map(
		(row) => row.dataset.itemId ?? "",
	);
}

function setSearch(target: HTMLElement, value: string) {
	const input = target.querySelector<HTMLInputElement>('input[type="search"]');
	if (!input) throw new Error("Search input was not rendered");
	input.value = value;
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(element: Element | null) {
	element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	for (const app of mountedApps.splice(0)) unmount(app);
	document.body.innerHTML = "";
	resetMocks();
});

describe("ProcessesPage", () => {
	it("requests server-side search and renders the returned page without filtering it again", async () => {
		mocks.browseItemsStore.set([
			{ kind: "process", item: makeRow({ instanceId: "agt_title", title: "Archive navigation" }) },
			{ kind: "process", item: makeRow({ instanceId: "agt_prompt", title: "Unrelated" }) },
			{ kind: "future", item: makeFuture() },
		]);
		setBrowseState({
			pagination: {
				limit: 100,
				offset: 0,
				total: 3,
				processTotal: 2,
				futureExecutionTotal: 1,
				hasMore: false,
			},
		});
		const target = mountSubject();
		await flush();

		setSearch(target, "archive");
		await new Promise((resolve) => setTimeout(resolve, 190));

		expect(mocks.loadProcessBrowse).toHaveBeenLastCalledWith({
			limit: 100,
			query: "archive",
			status: "all",
			processType: "",
			sortKey: "timeline",
			sortDirection: "desc",
		});
		expect(itemIds(target).sort()).toEqual(["agt_prompt", "agt_title", "fut_1"]);

		click(target.querySelector('[data-item-id="agt_title"] a'));
		expect(mocks.navigate).toHaveBeenCalledWith("/processes/agt_title");
	});

	it("sends status and process-type controls to the server", async () => {
		setBrowseState({
			facets: {
				statusCounts: { ...EMPTY_COUNTS, all: 4, needs_attention: 1 },
				processTypes: [{ value: "ticket_issue_process", label: "Ticket issue", count: 1 }],
			},
		});
		const target = mountSubject();
		await flush();

		click(target.querySelector('[data-filter-status="needs_attention"]'));
		await flush();
		const select = target.querySelector<HTMLSelectElement>('[data-filter="process-type"]');
		if (!select) throw new Error("Process type filter missing");
		select.value = "ticket_issue_process";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		await flush();
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(mocks.loadProcessBrowse).toHaveBeenLastCalledWith({
			limit: 100,
			query: "",
			status: "needs_attention",
			processType: "ticket_issue_process",
			sortKey: "timeline",
			sortDirection: "desc",
		});
		expect(readProcessBrowserView(window.localStorage)).toEqual({
			status: "needs_attention",
			processType: "ticket_issue_process",
			sort: { key: "timeline", direction: "desc" },
		});
	});

	it("restores the operator's last archive view and exposes unavailable process types", async () => {
		writeProcessBrowserView(window.localStorage, {
			status: "completed",
			processType: "removed_process",
			sort: { key: "title", direction: "asc" },
		});
		setBrowseState({
			facets: {
				statusCounts: { ...EMPTY_COUNTS, all: 4, completed: 3 },
				processTypes: [],
			},
		});

		const target = mountSubject();
		await flush();
		await new Promise((resolve) => setTimeout(resolve, 5));

		expect(mocks.loadProcessBrowse).toHaveBeenLastCalledWith({
			limit: 100,
			query: "",
			status: "completed",
			processType: "removed_process",
			sortKey: "title",
			sortDirection: "asc",
		});
		expect(
			target.querySelector('[data-filter-status="completed"]')?.getAttribute("aria-pressed"),
		).toBe("true");
		const selectedType = target.querySelector<HTMLSelectElement>('[data-filter="process-type"]');
		expect(selectedType?.value).toBe("removed_process");
		expect(selectedType?.selectedOptions[0]?.textContent).toContain("unavailable");
	});

	it("renders server facets and the active-filter empty state", async () => {
		setBrowseState({
			facets: {
				statusCounts: { ...EMPTY_COUNTS, all: 3, running: 2, scheduled: 1 },
				processTypes: [],
			},
		});
		const target = mountSubject();
		await flush();
		expect(target.querySelector('[data-filter-status="running"] .chip-count')?.textContent).toBe(
			"2",
		);

		setSearch(target, "missing");
		await flush();
		expect(target.querySelector('[data-state="processes-no-results"]')).toBeTruthy();
	});

	it("shows a scheduled-action target only as the process row returned by the server", async () => {
		mocks.browseItemsStore.set([{ kind: "process", item: makeRow({ instanceId: "agt_1" }) }]);
		setBrowseState({
			pagination: {
				limit: 100,
				offset: 0,
				total: 1,
				processTotal: 1,
				futureExecutionTotal: 0,
				hasMore: false,
			},
		});
		const target = mountSubject();
		await flush();

		expect(itemIds(target)).toEqual(["agt_1"]);
		expect(target.querySelector('[data-item-kind="future"]')).toBeNull();
	});
});
