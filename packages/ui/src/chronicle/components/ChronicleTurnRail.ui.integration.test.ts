/// <reference types="svelte" />
import { mount, tick, unmount } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessDetailData } from "../../lib/api.js";
import type { ChronicleSelectableItem } from "../lib/chronicle-selectable-items.js";
import ChronicleTurnRail from "./ChronicleTurnRail.svelte";

const apps: ReturnType<typeof mount>[] = [];
afterEach(async () => {
	for (const app of apps.splice(0)) await unmount(app);
	document.body.innerHTML = "";
});

function setup(
	activeAnchorId = "turn-4",
	currentItem?: ChronicleSelectableItem,
	outcomes: Record<string, string> = {},
) {
	const railItems: ChronicleSelectableItem[] = [
		"Implement",
		"Review",
		"Implement",
		"Review",
		"Implement",
	].map((title, index) => ({
		kind: "turn",
		anchorId: `turn-${index}`,
		turnRecordId: `record-${index}`,
		turnId: title,
		title,
		label: "Turn",
		detail: null,
		hierarchy: "primary",
		tone: title === "Review" ? "operator_decision" : "llm_turn",
		markerText: "",
		status: index === 4 ? "in_progress" : "completed",
		shape: "circle",
	}));
	if (currentItem) railItems[4] = currentItem;
	const target = document.createElement("div");
	document.body.appendChild(target);
	const onSelectAnchor = vi.fn();
	const detail = {
		process: { selectedTurnId: "Implement" },
		plannedNextTurn: { turnId: "Review", description: "Review" },
		processFlow: {
			spine: ["Implement", "Review"],
			nodes: [{ turnId: "Review", description: "Review" }],
		},
		timeline: {
			turns: railItems.map((_, index) => ({
				id: `record-${index}`,
				outcome:
					outcomes[`record-${index}`] ??
					(index === 1 ? "Approve" : index === 3 ? "Adjust" : "succeeded"),
				startedAt: "2026-09-10T12:00:00Z",
				endedAt: "2026-09-10T12:12:14Z",
			})),
		},
	} as ProcessDetailData;
	const state = new SvelteMap<string, ChronicleSelectableItem[]>([["items", railItems]]);
	apps.push(
		mount(ChronicleTurnRail, {
			target,
			props: {
				detail,
				get railItems() {
					return state.get("items") ?? [];
				},
				activeAnchorId,
				onSelectAnchor,
				loading: false,
				error: null,
			},
		}),
	);
	return {
		target,
		onSelectAnchor,
		setRailItems: (items: ChronicleSelectableItem[]) => state.set("items", items),
		railItems,
	};
}
const flush = async () => {
	await tick();
	await Promise.resolve();
};

describe("turn rail repeated history", () => {
	it("keeps the selected turn visible and focused when new history groups it", async () => {
		const { target, railItems, setRailItems, onSelectAnchor } = setup("turn-2");
		setRailItems(railItems.slice(0, 3));
		await flush();
		expect(target.querySelector('[data-section="repeated-turns"]')).toBeNull();
		const selected = target.querySelector<HTMLButtonElement>('[data-rail-anchor-id="turn-2"]');
		selected?.focus();
		setRailItems(railItems);
		await flush();
		expect(target.querySelector("[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
		expect(target.querySelector('[aria-current="step"]')?.getAttribute("data-rail-anchor-id")).toBe(
			"turn-2",
		);
		expect(document.activeElement?.getAttribute("data-rail-anchor-id")).toBe("turn-2");
		expect(onSelectAnchor).not.toHaveBeenCalled();
		const toggle = target.querySelector<HTMLButtonElement>("[aria-expanded]");
		toggle?.click();
		await flush();
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
	});

	it("shows recorded decisions and duration in repeated history", async () => {
		const { target } = setup("turn-1");
		await flush();
		const approved = target.querySelector('[data-rail-anchor-id="turn-1"]');
		expect(approved?.querySelector(".rail-detail")?.textContent).toBe("Approved · 12m 14s");
		expect(approved?.getAttribute("aria-label")).toContain("Approved · 12m 14s");
		expect(target.querySelector('[data-rail-anchor-id="turn-3"] .rail-detail')?.textContent).toBe(
			"Adjust · 12m 14s",
		);
		expect(target.querySelector('[data-rail-anchor-id="turn-0"] .rail-detail')?.textContent).toBe(
			"Completed · 12m 14s",
		);
	});

	it("falls back to completion when a human turn has no recorded decision", async () => {
		const { target } = setup("turn-1", undefined, { "record-1": "succeeded", "record-3": "" });
		await flush();
		for (const anchorId of ["turn-1", "turn-3"]) {
			expect(
				target.querySelector(`[data-rail-anchor-id="${anchorId}"] .rail-detail`)?.textContent,
			).toBe("Completed · 12m 14s");
		}
	});

	it("reveals normal history buttons without selecting a turn and preserves current work", async () => {
		const { target, onSelectAnchor } = setup();
		await flush();
		const toggle = target.querySelector<HTMLButtonElement>("[aria-expanded]");
		if (!toggle) throw new Error("Expected the repeated-turn disclosure");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.textContent).toContain("4 turns");
		expect(toggle.textContent).toContain("12m 14s");
		expect(target.querySelectorAll("[data-rail-anchor-id]")).toHaveLength(1);
		expect(target.querySelector('[data-section="upcoming-turn"]')?.textContent).toContain(
			"ReviewPending",
		);
		toggle.click();
		await flush();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(
			document
				.getElementById(toggle.getAttribute("aria-controls") ?? "")
				?.querySelectorAll(".rail-item"),
		).toHaveLength(4);
		expect(onSelectAnchor).not.toHaveBeenCalled();
		target.querySelector<HTMLButtonElement>('[data-rail-anchor-id="turn-1"]')?.click();
		expect(onSelectAnchor).toHaveBeenCalledWith("turn-1");
		toggle.click();
		await flush();
		expect(target.querySelectorAll("[data-rail-anchor-id]")).toHaveLength(1);
		expect(target.querySelector('[data-state="live"]')).toBeTruthy();
	});
	it("moves between visible controls and supports left/right disclosure keys", async () => {
		const { target, onSelectAnchor } = setup();
		await flush();
		const toggle = target.querySelector<HTMLButtonElement>("[aria-expanded]");
		if (!toggle) throw new Error("Expected the repeated-turn disclosure");
		toggle.focus();
		toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement?.getAttribute("data-rail-anchor-id")).toBe("turn-4");
		expect(onSelectAnchor).toHaveBeenLastCalledWith("turn-4");
		toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		await flush();
		toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(document.activeElement?.getAttribute("data-rail-anchor-id")).toBe("turn-0");
		toggle.focus();
		toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		await flush();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(document.activeElement).toBe(toggle);
	});
	it("reveals a selected historical anchor but allows an explicit collapse", async () => {
		const { target } = setup("turn-1");
		await flush();
		const toggle = target.querySelector<HTMLButtonElement>("[aria-expanded]");
		if (!toggle) throw new Error("Expected the repeated-turn disclosure");
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(target.querySelector('[aria-current="step"]')?.getAttribute("data-rail-anchor-id")).toBe(
			"turn-1",
		);
		toggle.click();
		await flush();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});
});

describe("turn rail current state", () => {
	it.each([
		["operator_decision", "Review", "Awaiting your decision", "waiting"],
		["external_trigger", "Waiting for an update", "Review", "waiting"],
		["scheduled_action", "Scheduled action", "Tomorrow at 09:00", "waiting"],
		["error_recovery", "Retry failed turn", "Worker disconnected", "failed"],
	] as const)("preserves %s state while history is selected", async (tone, title, detail, state) => {
		const { target, onSelectAnchor } = setup("turn-1", {
			kind: "action",
			anchorId: "current-action",
			title,
			label: "Action",
			detail,
			hierarchy: "secondary",
			tone,
			markerText: "",
		});
		await flush();
		const current = target.querySelector<HTMLButtonElement>(
			'[data-rail-anchor-id="current-action"]',
		);
		expect(current?.getAttribute("data-state")).toBe(state);
		expect(current?.getAttribute("data-active")).toBe("false");
		expect(current?.getAttribute("aria-label")).toContain(detail);
		expect(target.querySelector('[data-state="pending"]')).toBeNull();
		current?.click();
		expect(onSelectAnchor).toHaveBeenCalledWith("current-action");
	});

	it("distinguishes running work from its future turn while history is selected", async () => {
		const { target } = setup("turn-1");
		await flush();
		const current = target.querySelector('[data-rail-anchor-id="turn-4"]');
		expect(current?.getAttribute("data-state")).toBe("live");
		expect(current?.getAttribute("data-active")).toBe("false");
		expect(current?.getAttribute("aria-label")).toContain("In progress");
		const upcoming = target.querySelector('[data-section="upcoming-turn"]');
		expect(upcoming?.getAttribute("data-state")).toBe("pending");
		expect(upcoming?.textContent).toContain("ReviewPending");
	});
});
