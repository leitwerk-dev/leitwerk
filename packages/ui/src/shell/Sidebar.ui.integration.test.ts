// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar.svelte";

const mocks = vi.hoisted(() => {
	function createStore<T>(initial: T) {
		let value = initial;
		const subscribers = new Set<(value: T) => void>();
		return {
			subscribe(run: (value: T) => void) {
				run(value);
				subscribers.add(run);
				return () => {
					subscribers.delete(run);
				};
			},
			set(next: T) {
				value = next;
				for (const subscriber of subscribers) {
					subscriber(value);
				}
			},
			get() {
				return value;
			},
		};
	}

	return {
		futureExecutionsStore: createStore([] as unknown[]),
		listStateStore: createStore({ loading: false, error: null as string | null }),
		processRowsStore: createStore([] as unknown[]),
		wsStore: createStore({
			status: "connected",
			serverVersion: "test-server",
			reconnectCount: 0,
		}),
		keyboardShortcutHelpOpenStore: createStore(false),
		loadProcessesList: vi.fn().mockResolvedValue(undefined),
		navigate: vi.fn(),
		toggleKeyboardShortcutHelp: vi.fn(),
	};
});

vi.mock("../lib/keyboard-shortcuts-help.js", () => ({
	keyboardShortcutHelpOpen: mocks.keyboardShortcutHelpOpenStore,
	toggleKeyboardShortcutHelp: mocks.toggleKeyboardShortcutHelp,
}));

vi.mock("../lib/processes.svelte", () => ({
	futureExecutions: mocks.futureExecutionsStore,
	listState: mocks.listStateStore,
	loadProcessesList: mocks.loadProcessesList,
	processRows: mocks.processRowsStore,
}));

vi.mock("../lib/router.svelte", () => ({
	buildFutureLaunchPath: vi.fn(
		(futureExecutionId: string) => `/future-launches/${futureExecutionId}`,
	),
	buildHomePath: vi.fn(() => "/"),
	buildProcessesPath: vi.fn(() => "/processes"),
	buildProcessPath: vi.fn((instanceId: string) => `/processes/${instanceId}`),
	buildSkillsPath: vi.fn(() => "/skills"),
	buildWatchersPath: vi.fn(() => "/watchers"),
	followLink: (event: MouseEvent, path: string) => {
		event.preventDefault();
		mocks.navigate(path);
	},
	navigate: mocks.navigate,
}));

vi.mock("../lib/ws.svelte", () => ({
	wsStore: mocks.wsStore,
}));

const HOME_ROUTE = { page: "home", params: {} };
const mountedApps: Array<ReturnType<typeof mount>> = [];

function makeRow(
	instanceId: string,
	title: string,
	statusCategory: "active" | "waiting" | "error" | "terminal",
	lifecycleStatus: "active" | "waiting" | "error" | "completed",
	processDisplayName = "Poem Creator",
) {
	const statusLabels = {
		active: "Running",
		waiting: "Waiting",
		error: "Error",
		completed: "Completed",
	} as const;
	const statusLabel = statusLabels[lifecycleStatus];

	return {
		instanceId,
		title,
		processDisplayName,
		subtitle: `${title} subtitle`,
		statusCategory,
		lifecycleStatus,
		selectedTurnId: statusCategory === "terminal" ? null : "run_turn",
		statusLabel,
		turnLabel: statusCategory === "terminal" ? null : "Run turn",
		statusLine: `${statusLabel} · Run turn`,
		closedAt: statusCategory === "terminal" ? "2026-01-01T00:00:00Z" : null,
	} as const;
}

function resetMocks() {
	mocks.futureExecutionsStore.set([]);
	mocks.listStateStore.set({ loading: false, error: null });
	mocks.processRowsStore.set([]);
	mocks.wsStore.set({
		status: "connected",
		serverVersion: "test-server",
		reconnectCount: 0,
	});
	mocks.keyboardShortcutHelpOpenStore.set(false);
	vi.clearAllMocks();
	mocks.loadProcessesList.mockResolvedValue(undefined);
}

function mountSubject(currentRoute = HOME_ROUTE) {
	const target = document.createElement("div");
	document.body.appendChild(target);

	mountedApps.push(
		mount(Sidebar, {
			target,
			props: {
				currentRoute,
			},
		}),
	);

	return { target };
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function click(element: Element | null) {
	element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

afterEach(() => {
	for (const app of mountedApps.splice(0)) {
		unmount(app);
	}
	document.body.innerHTML = "";
	resetMocks();
});

describe("Sidebar", () => {
	it("renders the Leitwerk header, active work, and the all-processes primary link", async () => {
		mocks.processRowsStore.set([
			makeRow("agt_1", "RUN-101", "active", "active"),
			makeRow("agt_2", "DONE-101", "terminal", "completed"),
		]);

		const { target } = mountSubject();
		await flush();

		expect(target.querySelector('[data-sidebar-state="expanded"]')).toBeTruthy();
		expect(target.textContent).toContain("Leitwerk");
		expect(target.querySelector('[data-action="toggle-sidebar"]')).toBeTruthy();
		expect(target.querySelector('[data-action="create-process"]')).toBeTruthy();
		expect(target.textContent).toContain("Start a process");
		expect(target.textContent).toContain("Watchers");
		expect(target.querySelector('[data-action="view-watchers"]')).toBeTruthy();
		expect(target.textContent).toContain("Future");
		expect(target.textContent).toContain("Waiting");
		expect(target.textContent).toContain("Running");
		expect(target.textContent).toContain("All processes");
		expect(target.textContent).not.toContain("finished process in archive");
		expect(target.querySelector('[data-action="view-all-processes"]')).toBeTruthy();
		expect(target.textContent).toContain("RUN-101");
		expect(target.textContent).not.toContain("DONE-101");
	});

	it("shows scheduled-action Future rows with 24-hour time", async () => {
		mocks.futureExecutionsStore.set([
			{
				id: "fut_1",
				kind: "action",
				scheduleKind: "once",
				nextRunAt: "2026-01-01T13:05:00Z",
				title: "Approve patch",
				instanceId: "agt_1",
				actionLabel: "Approve patch",
			},
		]);

		const { target } = mountSubject();
		await flush();

		const futureRowSecondary = target.querySelector<HTMLElement>(".future-row .row-secondary");
		expect(futureRowSecondary?.textContent).toContain(":");
		expect(futureRowSecondary?.textContent).not.toMatch(/\b[ap]m\b/i);
	});

	it("opens scheduled launches as selected detail rows without inline actions", async () => {
		mocks.futureExecutionsStore.set([
			{
				id: "fut_launch_1",
				kind: "launch",
				scheduleKind: "once",
				nextRunAt: "2026-01-01T13:05:00Z",
				title: "Polish MR later",
				processId: "mr_polish_process",
				subtitle: "Scheduled start",
				launcherId: "mr-polish",
				launcherLabel: "MR polish",
				launchTitle: "Polish MR later",
				launcherInput: {},
				modelConfig: {},
			},
		]);

		const { target } = mountSubject({
			page: "future-launch-detail",
			params: { futureExecutionId: "fut_launch_1" },
		});
		await flush();

		const row = target.querySelector('a[href="/future-launches/fut_launch_1"]');
		expect(row?.getAttribute("aria-current")).toBe("page");
		expect(row?.querySelector("button")).toBeNull();

		click(row);
		await flush();

		expect(mocks.navigate).toHaveBeenCalledWith("/future-launches/fut_launch_1");
	});

	it("shows process cards with a wrapped title and a step-plus-process-name subline", async () => {
		mocks.processRowsStore.set([
			makeRow(
				"agt_1",
				"Generate Poem: Germany April 2026 or Cloud Software",
				"active",
				"active",
				"Poem Creator",
			),
		]);

		const { target } = mountSubject();
		await flush();

		const row = target.querySelector('a[href="/processes/agt_1"]');
		expect(row?.querySelector(".row-title")?.textContent).toBe(
			"Generate Poem: Germany April 2026 or Cloud Software",
		);
		expect(row?.querySelector(".row-meta")?.textContent).toBe("Running · Run turn · Poem Creator");
		expect(row?.textContent).not.toContain("preview");
	});

	it("collapses into an icon rail and quick-switches between current processes", async () => {
		mocks.processRowsStore.set([
			makeRow("agt_1", "RUN-101", "active", "active"),
			makeRow("agt_2", "RUN-102", "waiting", "waiting"),
			makeRow("agt_3", "DONE-101", "terminal", "completed"),
		]);

		const { target } = mountSubject({
			page: "process-detail",
			params: { instanceId: "agt_1" },
		});
		await flush();

		click(target.querySelector('[data-action="toggle-sidebar"]'));
		await flush();

		expect(target.querySelector('[data-sidebar-state="collapsed"]')).toBeTruthy();
		expect(target.querySelector('[data-action="view-watchers"]')).toBeTruthy();
		expect(target.querySelector('[data-action="view-all-processes"]')).toBeTruthy();
		expect(target.querySelector('[data-action="future-executions"]')).toBeTruthy();
		expect(target.textContent).toContain("Future");
		expect(target.textContent).not.toContain("Browse");

		const currentProcessesButton = target.querySelector(
			'[data-action="current-processes"]',
		) as HTMLButtonElement | null;
		expect(currentProcessesButton).toBeTruthy();
		click(currentProcessesButton);
		await flush();

		expect(currentProcessesButton?.getAttribute("aria-expanded")).toBe("true");
		const popover = target.querySelector('[data-section="current-processes-popover"]');
		expect(popover).toBeTruthy();
		expect(popover?.textContent).toContain("Waiting and running");
		expect(popover?.textContent).toContain("RUN-101");
		expect(popover?.textContent).toContain("RUN-102");
		expect(popover?.textContent).not.toContain("DONE-101");

		const selectedLink = popover?.querySelector('a[href="/processes/agt_1"]');
		expect(selectedLink?.getAttribute("aria-current")).toBe("page");

		click(popover?.querySelector('a[href="/processes/agt_2"]') ?? null);
		await flush();

		expect(mocks.navigate).toHaveBeenCalledWith("/processes/agt_2");
		expect(target.querySelector('[data-section="current-processes-popover"]')).toBeNull();
	});

	it("closes the current-processes popover on Escape", async () => {
		mocks.processRowsStore.set([makeRow("agt_1", "RUN-101", "active", "active")]);

		const { target } = mountSubject();
		await flush();

		click(target.querySelector('[data-action="toggle-sidebar"]'));
		await flush();
		click(target.querySelector('[data-action="current-processes"]'));
		await flush();
		expect(target.querySelector('[data-section="current-processes-popover"]')).toBeTruthy();

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await flush();

		expect(target.querySelector('[data-section="current-processes-popover"]')).toBeNull();
		expect(
			(target.querySelector('[data-action="current-processes"]') as HTMLButtonElement).getAttribute(
				"aria-expanded",
			),
		).toBe("false");
	});

	it("shows the loading state in the current-processes popover", async () => {
		mocks.listStateStore.set({ loading: true, error: null });

		const { target } = mountSubject();
		await flush();

		click(target.querySelector('[data-action="toggle-sidebar"]'));
		await flush();
		click(target.querySelector('[data-action="current-processes"]'));
		await flush();

		expect(
			target.querySelector('[data-section="current-processes-popover"]')?.textContent,
		).toContain("Loading active processes…");
	});

	it("shows connection errors alongside the empty current-processes state", async () => {
		mocks.listStateStore.set({ loading: false, error: "Couldn't load the process list" });

		const { target } = mountSubject();
		await flush();

		click(target.querySelector('[data-action="toggle-sidebar"]'));
		await flush();

		const currentProcessesButton = target.querySelector(
			'[data-action="current-processes"]',
		) as HTMLButtonElement | null;
		expect(currentProcessesButton?.title).toContain("Couldn't load the process list");

		click(currentProcessesButton);
		await flush();

		const popoverText = target.querySelector(
			'[data-section="current-processes-popover"]',
		)?.textContent;
		expect(popoverText).toContain("Couldn't load the process list");
		expect(popoverText).toContain(
			"No waiting or running processes. Start one above and it will appear here.",
		);
	});
});
