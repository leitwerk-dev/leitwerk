// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cancelSessionTransfer,
	createSessionTransferGrant,
	deleteProcess,
	fetchProcessRetryConfig,
	postProcessAbort,
} from "../lib/api.js";
import { setPendingRetryConfig } from "../lib/retry-config.svelte.js";
import { buildHomePath, navigate } from "../lib/router.svelte.js";
import ProcessActionsMenu from "./ProcessActionsMenu.svelte";

const defaultRetryConfig = {
	launcherId: "test-launcher",
	title: "Retry Title",
	launcherInput: { field: "value" },
	skillIds: ["review"],
	modelConfig: {},
};

vi.mock("../lib/api.js", () => ({
	cancelSessionTransfer: vi.fn(),
	createSessionTransferGrant: vi.fn(),
	deleteProcess: vi.fn(),
	fetchProcessRetryConfig: vi.fn(),
	postProcessAbort: vi.fn(),
}));

vi.mock("../lib/retry-config.svelte.js", () => ({
	setPendingRetryConfig: vi.fn(),
}));

vi.mock("../lib/router.svelte.js", () => ({
	navigate: vi.fn(),
	buildHomePath: vi.fn(),
}));

function resetDefaultMocks() {
	vi.mocked(fetchProcessRetryConfig).mockResolvedValue({
		...defaultRetryConfig,
		launcherInput: { ...defaultRetryConfig.launcherInput },
		skillIds: [...defaultRetryConfig.skillIds],
		modelConfig: { ...defaultRetryConfig.modelConfig },
	});
	vi.mocked(postProcessAbort).mockResolvedValue(undefined);
	vi.mocked(deleteProcess).mockResolvedValue(undefined);
	vi.mocked(cancelSessionTransfer).mockResolvedValue(undefined);
	vi.mocked(createSessionTransferGrant).mockResolvedValue({
		transferUrl:
			"https://leitwerk.example/api/session-transfers/test-instance-id/trg_1#token=secret-token",
		expiresAt: "2026-09-01T01:00:00.000Z",
	});
	vi.mocked(buildHomePath).mockImplementation((launcherId?: string | null) =>
		launcherId ? `/?launcher=${launcherId}` : "/",
	);
}

resetDefaultMocks();

function mountSubject({
	lifecycleStatus = "active",
	disabled = false,
	processLabel = "Test process",
	onDeleted,
	hasSessionFile = false,
	sessionTransfer = null,
}: {
	lifecycleStatus?: string | null;
	disabled?: boolean;
	processLabel?: string | null;
	onDeleted?: () => void;
	hasSessionFile?: boolean;
	sessionTransfer?: {
		attemptId: string;
		phase: string;
		blocksManualTurns: boolean;
	} | null;
} = {}) {
	const target = document.createElement("div");
	document.body.appendChild(target);

	const app = mount(ProcessActionsMenu, {
		target,
		props: {
			instanceId: "test-instance-id",
			lifecycleStatus,
			disabled,
			processLabel,
			onDeleted,
			hasSessionFile,
			sessionTransfer,
		},
	});

	return { app, target };
}

async function flush() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function openMenu(target: HTMLElement) {
	const trigger = target.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
	trigger?.click();
}

function clickButtonByText(target: HTMLElement, text: string) {
	const button = Array.from(target.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === text,
	) as HTMLButtonElement | undefined;
	button?.click();
}

function getMenuItems(target: HTMLElement): string[] {
	return Array.from(target.querySelectorAll('[role="menuitem"]')).map(
		(el) => el.textContent?.trim() ?? "",
	);
}

afterEach(() => {
	document.body.innerHTML = "";
	vi.clearAllMocks();
	resetDefaultMocks();
});

async function expectMenuItemsForLifecycleStatus(
	lifecycleStatus: string,
	expectedItems: string[],
	unexpectedItems: string[] = [],
) {
	const { app, target } = mountSubject({ lifecycleStatus });
	await flush();

	openMenu(target);
	await flush();

	const items = getMenuItems(target);
	for (const item of expectedItems) {
		expect(items).toContain(item);
	}
	for (const item of unexpectedItems) {
		expect(items).not.toContain(item);
	}

	unmount(app);
}

describe("ProcessActionsMenu", () => {
	describe("menu visibility based on lifecycle status", () => {
		for (const lifecycleStatus of ["discovered", "active", "waiting", "error"] as const) {
			it(`shows active and destructive options when process is ${lifecycleStatus}`, async () => {
				await expectMenuItemsForLifecycleStatus(lifecycleStatus, [
					"Abort process",
					"Retry as new process",
					"Abort and retry as new process",
					"Delete process",
				]);
			});
		}

		for (const lifecycleStatus of ["completed", "aborted"] as const) {
			it(`shows Retry and Delete when process is ${lifecycleStatus}`, async () => {
				await expectMenuItemsForLifecycleStatus(
					lifecycleStatus,
					["Retry as new process", "Delete process"],
					["Abort process", "Abort and retry as new process"],
				);
			});
		}
	});

	describe("delete", () => {
		it("confirms permanent deletion and reports success", async () => {
			const onDeleted = vi.fn();
			const { app, target } = mountSubject({ onDeleted });
			openMenu(target);
			await flush();

			clickButtonByText(target, "Delete process");
			await flush();
			expect(target.textContent).toContain("History and managed stored artifacts");
			expect(target.textContent).toContain("Active work will be stopped first");
			expect(deleteProcess).not.toHaveBeenCalled();

			clickButtonByText(target, "Delete process");
			await flush();
			expect(deleteProcess).toHaveBeenCalledWith("test-instance-id");
			expect(onDeleted).toHaveBeenCalledOnce();
			unmount(app);
		});

		it("keeps the confirmation open when deletion fails", async () => {
			vi.mocked(deleteProcess).mockRejectedValueOnce(new Error("Cleanup failed"));
			const { app, target } = mountSubject({ lifecycleStatus: "completed" });
			openMenu(target);
			await flush();
			clickButtonByText(target, "Delete process");
			await flush();
			expect(target.textContent).not.toContain("Active work will be stopped first");
			clickButtonByText(target, "Delete process");
			await flush();
			expect(target.querySelector('[role="alert"]')?.textContent).toContain("Cleanup failed");
			unmount(app);
		});
	});

	describe("menu trigger", () => {
		it("names the process controlled by the gear icon button", async () => {
			const { app, target } = mountSubject({ processLabel: "Shell cleanup" });
			await flush();

			const trigger = target.querySelector('[aria-label="Open actions for Shell cleanup"]');
			expect(trigger).toBeTruthy();

			openMenu(target);
			await flush();
			expect(target.querySelector('[role="menu"]')?.getAttribute("aria-labelledby")).toBe(
				trigger?.id,
			);

			unmount(app);
		});

		it("toggles menu open and closed", async () => {
			const { app, target } = mountSubject();
			await flush();

			expect(target.querySelector('[role="menu"]')).toBeNull();

			openMenu(target);
			await flush();
			expect(target.querySelector('[role="menu"]')).toBeTruthy();

			openMenu(target);
			await flush();
			expect(target.querySelector('[role="menu"]')).toBeNull();

			unmount(app);
		});

		it("is disabled when disabled prop is true", async () => {
			const { app, target } = mountSubject({ disabled: true });
			await flush();

			const trigger = target.querySelector('button[aria-haspopup="menu"]') as HTMLButtonElement;
			expect(trigger?.disabled).toBe(true);

			unmount(app);
		});
	});

	describe("retry actions", () => {
		it("loads retry config and navigates to launcher setup when Retry is chosen", async () => {
			const { app, target } = mountSubject();
			await flush();

			openMenu(target);
			await flush();
			clickButtonByText(target, "Retry as new process");
			await flush();

			expect(fetchProcessRetryConfig).toHaveBeenCalledWith("test-instance-id");
			expect(postProcessAbort).not.toHaveBeenCalled();
			expect(setPendingRetryConfig).toHaveBeenCalledWith(
				expect.objectContaining({ launcherId: "test-launcher", title: "Retry Title" }),
			);
			expect(buildHomePath).toHaveBeenCalledWith("test-launcher");
			expect(navigate).toHaveBeenCalledWith("/?launcher=test-launcher");

			unmount(app);
		});

		it("loads retry config before aborting during abort and retry", async () => {
			const callOrder: string[] = [];
			vi.mocked(fetchProcessRetryConfig).mockImplementation(async () => {
				callOrder.push("fetch");
				return {
					...defaultRetryConfig,
					launcherInput: { ...defaultRetryConfig.launcherInput },
					skillIds: [...defaultRetryConfig.skillIds],
					modelConfig: { ...defaultRetryConfig.modelConfig },
				};
			});
			vi.mocked(postProcessAbort).mockImplementation(async () => {
				callOrder.push("abort");
			});

			const { app, target } = mountSubject();
			await flush();

			openMenu(target);
			await flush();
			clickButtonByText(target, "Abort and retry as new process");
			await flush();
			clickButtonByText(target, "Abort & retry");
			await flush();

			expect(callOrder).toEqual(["fetch", "abort"]);
			expect(setPendingRetryConfig).toHaveBeenCalledWith(
				expect.objectContaining({ launcherId: "test-launcher", title: "Retry Title" }),
			);
			expect(buildHomePath).toHaveBeenCalledWith("test-launcher");
			expect(navigate).toHaveBeenCalledWith("/?launcher=test-launcher");

			unmount(app);
		});

		it("does not abort during abort and retry when loading retry config fails", async () => {
			vi.mocked(fetchProcessRetryConfig).mockRejectedValue(new Error("retry config unavailable"));

			const { app, target } = mountSubject();
			await flush();

			openMenu(target);
			await flush();
			clickButtonByText(target, "Abort and retry as new process");
			await flush();
			clickButtonByText(target, "Abort & retry");
			await flush();

			expect(fetchProcessRetryConfig).toHaveBeenCalledWith("test-instance-id");
			expect(postProcessAbort).not.toHaveBeenCalled();
			expect(setPendingRetryConfig).not.toHaveBeenCalled();
			expect(target.textContent).toContain("retry config unavailable");

			unmount(app);
		});
	});

	describe("local session transfer", () => {
		it("creates an expiring link only when a primary session exists", async () => {
			const { app, target } = mountSubject({ hasSessionFile: true });
			await flush();
			openMenu(target);
			await flush();
			clickButtonByText(target, "Create local transfer link");
			await flush();

			expect(createSessionTransferGrant).toHaveBeenCalledWith("test-instance-id");
			expect(target.textContent).toContain("Open this process in local Pi");
			expect(target.textContent).toContain("expires");
			expect(target.textContent).not.toContain("start within 1 hour");
			expect(target.textContent).toContain(
				"Anyone with this link can download this session and workspace.",
			);
			const transferLink = target.querySelector(".transfer-link") as HTMLInputElement;
			expect(transferLink.value).toContain("#token=secret-token");
			expect(document.activeElement).toBe(transferLink);
			unmount(app);
		});

		it("presents and cancels a transfer that still blocks manual turns", async () => {
			const { app, target } = mountSubject({
				sessionTransfer: {
					attemptId: "tra_1",
					phase: "scanning",
					blocksManualTurns: true,
				},
			});
			await flush();
			openMenu(target);
			await flush();
			expect(target.textContent).toContain("Local transfer: Scanning.");
			expect(target.textContent).toContain("New manual turns are blocked until streaming ends.");
			clickButtonByText(target, "Cancel transfer");
			await flush();
			expect(cancelSessionTransfer).toHaveBeenCalledWith("test-instance-id", "tra_1");
			unmount(app);
		});
	});
});
