// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiResponseError, type FutureLaunchSummary, type UiLauncherSummary } from "../lib/api.js";
import FutureLaunchDetailPage from "./FutureLaunchDetailPage.svelte";

const mocks = vi.hoisted(() => ({
	deleteFutureExecution: vi.fn().mockResolvedValue(undefined),
	fetchFutureExecution: vi.fn(),
	fetchLaunchers: vi.fn(),
	loadProcessesList: vi.fn().mockResolvedValue(undefined),
	navigate: vi.fn(),
}));

vi.mock("../lib/api.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/api.js")>();
	return {
		...actual,
		deleteFutureExecution: mocks.deleteFutureExecution,
		fetchFutureExecution: mocks.fetchFutureExecution,
		fetchLaunchers: mocks.fetchLaunchers,
	};
});

vi.mock("../lib/processes.svelte", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/processes.svelte")>();
	return {
		...actual,
		loadProcessesList: mocks.loadProcessesList,
	};
});

vi.mock("../lib/router.svelte", () => ({
	buildFutureLaunchPath: vi.fn(
		(futureExecutionId: string) => `/future-launches/${futureExecutionId}`,
	),
	buildHomePath: vi.fn(() => "/"),
	buildProcessesPath: vi.fn(() => "/processes"),
	buildProcessPath: vi.fn((instanceId: string) => `/processes/${instanceId}`),
	navigate: mocks.navigate,
}));

function createFutureLaunch(overrides: Partial<FutureLaunchSummary> = {}): FutureLaunchSummary {
	return {
		id: "fut_1",
		kind: "launch",
		scheduleKind: "once",
		processId: "mr_polish_process",
		nextRunAt: "2026-01-01T13:05:00.000Z",
		cronExpression: null,
		title: "Polish MR later",
		subtitle: "Scheduled start",
		launcherId: "mr-polish",
		launcherLabel: "MR polish",
		launchTitle: "Polish MR later",
		launcherInput: { repoPath: "/work/repo", instructions: "Polish this MR." },
		modelConfig: {},
		...overrides,
	};
}

function createLauncher(): UiLauncherSummary {
	return {
		id: "mr-polish",
		processId: "mr_polish_process",
		displayName: "MR Polish",
		label: "MR polish",
		description: "Polish a merge request",
		card: { title: "MR Polish", description: "Polish a merge request" },
		launchConfigSchema: {
			id: "mr-polish-form",
			title: "MR Polish",
			submitLabel: "Launch",
			fields: [
				{ id: "repoPath", label: "Repository", kind: "text" },
				{ id: "instructions", label: "Instructions", kind: "textarea" },
			],
		},
		modelConfigSchema: { availableProfiles: [], llmTurns: [] },
	};
}

const mountedApps: Array<ReturnType<typeof mount>> = [];

function mountSubject(futureExecutionId = "fut_1") {
	const target = document.createElement("div");
	document.body.appendChild(target);
	mountedApps.push(
		mount(FutureLaunchDetailPage, {
			target,
			props: { futureExecutionId },
		}),
	);
	return { target };
}

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function click(element: Element | null) {
	element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function resetMocks() {
	mocks.fetchFutureExecution.mockImplementation(async (futureExecutionId: string) =>
		createFutureLaunch({ id: futureExecutionId }),
	);
	mocks.fetchLaunchers.mockResolvedValue([createLauncher()]);
	mocks.deleteFutureExecution.mockResolvedValue(undefined);
	mocks.loadProcessesList.mockResolvedValue(undefined);
	vi.clearAllMocks();
}

resetMocks();

afterEach(() => {
	for (const app of mountedApps.splice(0)) {
		unmount(app);
	}
	document.body.innerHTML = "";
	resetMocks();
});

describe("FutureLaunchDetailPage", () => {
	it("loads and shows a scheduled launch without requiring an overview row", async () => {
		const { target } = mountSubject();
		await flush();

		expect(target.querySelector('[data-section="future-launch-detail"]')).toBeTruthy();
		expect(target.textContent).toContain("Polish MR later");
		expect(target.textContent).toContain("Repository");
		expect(target.textContent).toContain("/work/repo");
		expect(target.textContent).toContain("Instructions");
		expect(target.textContent).not.toContain("UTC UTC");
		expect(target.querySelector('[data-section="launcher-form"]')).toBeNull();
	});

	it("shows the policy block and recovery copy for a blocked launch", async () => {
		mocks.fetchFutureExecution.mockResolvedValue(
			createFutureLaunch({
				status: "blocked",
				blockedReason: {
					code: "model_stale",
					selection: {
						modelProfileId: "review-model",
						provenance: { kind: "explicit", source: "instance_default" },
					},
					summary: "Model status has not been refreshed",
					detectedAt: "2026-01-01T00:00:00Z",
					availabilityRevision: 2,
				},
			}),
		);

		const { target } = mountSubject();
		await flush();

		const warning = target.querySelector('[data-section="model-policy-block"]');
		expect(warning?.textContent).toContain("Blocked — Model status has not been refreshed");
		expect(warning?.textContent).toContain(
			"Edit the model selection or restore model availability.",
		);
	});

	it("keeps editing unavailable when the launcher definition cannot be loaded", async () => {
		mocks.fetchLaunchers.mockResolvedValue([]);

		const { target } = mountSubject();
		await flush();

		const editButton = target.querySelector("button.secondary-button");
		expect(editButton).toBeInstanceOf(HTMLButtonElement);
		expect((editButton as HTMLButtonElement).disabled).toBe(true);

		click(editButton);
		await flush();

		expect(target.querySelector('[data-section="launcher-form"]')).toBeNull();
	});

	it("requires confirmation before canceling and returns to the new process view", async () => {
		const { target } = mountSubject();
		await flush();

		click(target.querySelector(".danger-button"));
		await flush();

		expect(mocks.deleteFutureExecution).not.toHaveBeenCalled();
		expect(target.querySelector('[data-section="cancel-confirmation"]')).toBeTruthy();

		click(target.querySelector('[data-section="cancel-confirmation"] .danger-button'));
		await flush();

		expect(mocks.deleteFutureExecution).toHaveBeenCalledWith("fut_1");
		expect(mocks.loadProcessesList).toHaveBeenCalled();
		expect(mocks.navigate).toHaveBeenCalledWith("/");
	});

	it("waits for an explicit retry after a detail request fails", async () => {
		mocks.fetchFutureExecution.mockRejectedValueOnce(new Error("Temporary detail failure"));

		const { target } = mountSubject();
		await flush();
		await flush();

		expect(mocks.fetchFutureExecution).toHaveBeenCalledTimes(1);
		expect(target.querySelector('[data-section="future-launch-missing"]')?.textContent).toContain(
			"Temporary detail failure",
		);

		mocks.fetchFutureExecution.mockResolvedValue(createFutureLaunch());
		click(target.querySelector(".detail-load-error button"));
		await flush();

		expect(mocks.fetchFutureExecution).toHaveBeenCalledTimes(2);
		expect(target.querySelector('[data-section="future-launch-detail"]')).toBeTruthy();
	});

	it("shows a terminal missing state for a launch that ran or was canceled", async () => {
		mocks.fetchFutureExecution.mockRejectedValueOnce(
			new ApiResponseError("Couldn't load scheduled item: 404", 404),
		);

		const { target } = mountSubject();
		await flush();

		const missingState = target.querySelector('[data-section="future-launch-not-found"]');
		expect(missingState?.textContent).toContain("Scheduled launch no longer available");
		expect(missingState?.textContent).toContain("already run or been canceled");
		expect(missingState?.textContent).not.toContain("Retry");

		click(missingState?.querySelector("button") ?? null);
		expect(mocks.navigate).toHaveBeenCalledWith("/processes");
	});

	it("requests the route id directly when the item is outside the overview cap", async () => {
		const { target } = mountSubject("fut_outside_overview");
		await flush();

		expect(mocks.fetchFutureExecution).toHaveBeenCalledWith("fut_outside_overview");
		expect(mocks.loadProcessesList).not.toHaveBeenCalled();
		expect(target.querySelector('[data-section="future-launch-detail"]')).toBeTruthy();
	});
});
