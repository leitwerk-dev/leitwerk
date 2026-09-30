import type { ProcessToolApprovalRequest } from "@leitwerk-dev/domain";
import { tick } from "svelte";
import { beforeEach, expect, it, vi } from "vitest";
import { mountTest } from "../../test-support/mount.js";

const mocks = vi.hoisted(() => ({ tools: vi.fn(), resolve: vi.fn() }));
vi.mock("../../lib/api.js", () => ({
	fetchTicketCreationTools: mocks.tools,
	resolveToolApproval: mocks.resolve,
}));

import ChronicleToolApproval from "./ChronicleToolApproval.svelte";

const flush = async () => {
	await tick();
	await tick();
	await tick();
};
function subject() {
	const request: ProcessToolApprovalRequest = {
		id: "review",
		instanceId: "draft",
		turnRecordId: "turn",
		toolCallId: "call",
		toolName: "tracker_create_issue",
		arguments: {
			fields: {
				"~summary/title": "Improve the garden",
				description: "<script>untrusted</script>\nWeekly review.",
			},
		},
		destination: { id: "garden", displayName: "GARDEN / Task", group: "local · tracker.example" },
		status: "open",
		requestedAt: "2026-09-30T00:00:00Z",
		resolvedAt: null,
		resolvedBy: null,
		feedback: null,
	};
	return mountTest(ChronicleToolApproval, { request }).target;
}
function button(target: HTMLElement, text: string) {
	const found = [...target.querySelectorAll("button")].find(
		(button) => button.textContent?.trim() === text,
	);
	if (!found) throw new Error(`Missing ${text}`);
	return found;
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.tools.mockResolvedValue([
		{
			name: "tracker_create_issue",
			displayName: "Tracker",
			titlePath: "/fields/~0summary~1title",
			descriptionPath: "/fields/description",
		},
	]);
	mocks.resolve.mockResolvedValue({});
});

it("previews declared fields as safe text and creates only after explicit approval", async () => {
	const target = subject();
	await flush();
	expect(target.querySelector("h4")?.textContent).toBe("Improve the garden");
	expect(target.querySelector("script")).toBeNull();
	expect(target.textContent).toContain("GARDEN / Task");
	expect(mocks.resolve).not.toHaveBeenCalled();
	button(target, "Create issue").click();
	await flush();
	expect(mocks.resolve).toHaveBeenCalledWith({
		instanceId: "draft",
		requestId: "review",
		body: { action: "accept" },
	});
	expect(target.querySelector('[role="status"]')?.textContent).toContain("Approved");
});

it("focuses revision input and preserves it when submission fails", async () => {
	mocks.resolve.mockRejectedValueOnce(new Error("Connection interrupted"));
	const target = subject();
	await flush();
	button(target, "Request changes").click();
	await flush();
	const textarea = target.querySelector("textarea");
	expect(document.activeElement).toBe(textarea);
	expect(button(target, "Send changes").disabled).toBe(true);
	if (!textarea) throw new Error("Missing feedback");
	textarea.value = "Add weekly reminders";
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
	await flush();
	button(target, "Send changes").click();
	await flush();
	expect(textarea.value).toBe("Add weekly reminders");
	expect(target.querySelector('[role="alert"]')?.textContent).toContain("Connection interrupted");
	button(target, "Send changes").click();
	await flush();
	expect(mocks.resolve).toHaveBeenLastCalledWith({
		instanceId: "draft",
		requestId: "review",
		body: { action: "feedback", feedback: "Add weekly reminders" },
	});
});

it("keeps all arguments reviewable when presentation metadata is unavailable and can discard", async () => {
	mocks.tools.mockRejectedValue(new Error("offline"));
	const target = subject();
	await flush();
	expect(target.textContent).toContain("Improve the garden");
	button(target, "Discard draft").click();
	await flush();
	expect(mocks.resolve).toHaveBeenCalledWith({
		instanceId: "draft",
		requestId: "review",
		body: { action: "decline" },
	});
	expect(target.textContent).toContain("No issue was created");
});
