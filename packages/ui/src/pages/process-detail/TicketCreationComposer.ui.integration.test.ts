import { tick } from "svelte";
import { beforeEach, expect, it, vi } from "vitest";
import { mountTest } from "../../test-support/mount.js";

const mocks = vi.hoisted(() => ({ tools: vi.fn(), launch: vi.fn(), navigate: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
	fetchTicketCreationTools: mocks.tools,
	launchTicketCreation: mocks.launch,
}));
vi.mock("../../lib/router.svelte.js", () => ({
	buildProcessPath: (id: string) => `/processes/${id}`,
	navigate: mocks.navigate,
}));

import TicketCreationComposer from "./TicketCreationComposer.svelte";

const flush = async () => {
	await tick();
	await tick();
	await tick();
};

function subject() {
	const close = vi.fn();
	const { target } = mountTest(TicketCreationComposer, {
		instanceId: "parent",
		draft: { kind: "turn_result", turnRecordId: "retained" },
		onClose: close,
	});
	return { target, close };
}

function describeIssue(target: HTMLElement, value = "Make the mobile flow usable") {
	const textarea = target.querySelector("textarea");
	if (!textarea) throw new Error("Missing issue description");
	textarea.value = value;
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.tools.mockResolvedValue([{ name: "atlas_create_issue", displayName: "Atlas" }]);
});

it("retains the description and launch key when a lost response is retried", async () => {
	mocks.launch
		.mockRejectedValueOnce(new Error("Connection interrupted"))
		.mockResolvedValueOnce({ childInstanceId: "draft" });
	const { target, close } = subject();
	await flush();
	describeIssue(target);
	await flush();
	target.querySelector("form")?.requestSubmit();
	await flush();
	expect(target.querySelector('[role="alert"]')?.textContent).toContain("Connection interrupted");
	expect(target.querySelector("textarea")?.value).toBe("Make the mobile flow usable");
	expect(close).not.toHaveBeenCalled();
	target.querySelector("form")?.requestSubmit();
	await flush();
	expect(mocks.launch).toHaveBeenCalledTimes(2);
	expect(mocks.launch.mock.calls[1]).toEqual(mocks.launch.mock.calls[0]);
	expect(mocks.navigate).toHaveBeenCalledWith("/processes/draft");
});

it("ignores repeated submissions and disables all input while starting", async () => {
	const launch = Promise.withResolvers<unknown>();
	mocks.launch.mockReturnValue(launch.promise);
	const { target } = subject();
	await flush();
	describeIssue(target);
	await flush();
	const form = target.querySelector("form");
	form?.dispatchEvent(new Event("submit", { cancelable: true }));
	form?.dispatchEvent(new Event("submit", { cancelable: true }));
	await flush();
	expect(mocks.launch).toHaveBeenCalledTimes(1);
	expect(target.querySelector("fieldset")?.disabled).toBe(true);
	expect(
		target.querySelector('button[aria-label="Close issue creator"]')?.hasAttribute("disabled"),
	).toBe(true);
	launch.resolve({ childInstanceId: "draft" });
	await flush();
});

it("recovers ticket systems without losing typed instructions and requires an explicit system choice", async () => {
	mocks.tools.mockRejectedValueOnce(new Error("Systems unavailable")).mockResolvedValueOnce([
		{ name: "delta_create_issue", displayName: "Delta" },
		{ name: "cedar_create_issue", displayName: "Cedar" },
		{ name: "birch_create_issue", displayName: "Birch" },
		{ name: "atlas_create_issue", displayName: "Atlas" },
	]);
	const { target } = subject();
	await flush();
	describeIssue(target);
	[...target.querySelectorAll("button")]
		.find((button) => button.textContent === "Try again")
		?.click();
	await flush();
	expect(target.querySelector("textarea")?.value).toBe("Make the mobile flow usable");
	expect(
		[...target.querySelectorAll("select option")].slice(1).map((option) => option.textContent),
	).toEqual(["Atlas", "Birch", "Cedar", "Delta"]);
	expect(target.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
	const select = target.querySelector("select");
	if (!select) throw new Error("Missing ticket system");
	select.value = "delta_create_issue";
	select.dispatchEvent(new Event("change", { bubbles: true }));
	await flush();
	expect(target.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
});
