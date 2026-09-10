// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { ChronicleChecklistStep } from "../lib/chronicle-checklist.js";
import ChronicleChecklist from "./ChronicleChecklist.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];

function mountChecklist(title: string, steps: ChronicleChecklistStep[]) {
	const target = document.createElement("div");
	document.body.appendChild(target);
	mounted.push(
		mount(ChronicleChecklist, {
			target,
			props: {
				title,
				steps,
				meta: "Worker ready in 4s",
				summary: "A safe operator-facing summary",
				links: [{ id: "pr", label: "PR #42", url: "https://example.test/pulls/42" }],
				section: "test-checklist",
				ariaLive: "polite",
			},
		}),
	);
	return target;
}

afterEach(() => {
	for (const component of mounted.splice(0)) unmount(component);
	document.body.innerHTML = "";
});

describe("ChronicleChecklist", () => {
	it("renders every checklist tone with explicit state text in source order", () => {
		const target = mountChecklist("LLM workspace preparation", [
			{
				id: "pending",
				label: "Pending work",
				statusLabel: "Pending",
				tone: "pending",
				sourceStatus: "pending",
			},
			{
				id: "active",
				label: "Active work",
				detail: "Preparing a long workspace path",
				statusLabel: "In progress",
				tone: "active",
				sourceStatus: "in_progress",
			},
			{
				id: "success",
				label: "Successful work",
				statusLabel: "Complete",
				tone: "success",
				sourceStatus: "completed",
			},
			{
				id: "failed",
				label: "Failed work",
				statusLabel: "Failed",
				tone: "failed",
				sourceStatus: "failed",
			},
			{
				id: "superseded",
				label: "Superseded work",
				statusLabel: "Superseded",
				tone: "neutral",
				sourceStatus: "superseded",
			},
		]);

		const checklist = target.querySelector('[data-component="chronicle-checklist"]');
		expect(checklist?.getAttribute("aria-live")).toBeNull();
		const heading = target.querySelector("h4");
		expect(checklist?.getAttribute("aria-labelledby")).toBe(heading?.id);
		expect(heading?.textContent).toBe("LLM workspace preparation");
		expect(target.querySelector("ol")?.getAttribute("aria-live")).toBe("polite");
		expect(
			Array.from(target.querySelectorAll("ol > li"), (item) => ({
				id: item.getAttribute("data-checklist-step"),
				tone: item.getAttribute("data-checklist-status"),
				text: item.textContent?.replace(/\s+/g, " ").trim(),
			})),
		).toEqual([
			{ id: "pending", tone: "pending", text: "○ Pending work Pending" },
			{
				id: "active",
				tone: "active",
				text: "◐ Active work Preparing a long workspace path In progress",
			},
			{ id: "success", tone: "success", text: "✓ Successful work Complete" },
			{ id: "failed", tone: "failed", text: "× Failed work Failed" },
			{ id: "superseded", tone: "neutral", text: "– Superseded work Superseded" },
		]);
		expect(target.textContent).toContain("Worker ready in 4s");
		expect(target.textContent).toContain("A safe operator-facing summary");
	});

	it("keeps created-change links safe and keyboard focusable", () => {
		const target = mountChecklist("Delivery progress", []);
		const link = target.querySelector<HTMLAnchorElement>("a");
		expect(link?.getAttribute("href")).toBe("https://example.test/pulls/42");
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noreferrer");
		link?.focus();
		expect(document.activeElement).toBe(link);
	});

	it("assigns a distinct accessible heading to each checklist", () => {
		const first = mountChecklist("First checklist", []);
		const second = mountChecklist("Second checklist", []);
		const firstId = first.querySelector("h4")?.id;
		const secondId = second.querySelector("h4")?.id;
		expect(firstId).toBeTruthy();
		expect(secondId).toBeTruthy();
		expect(firstId).not.toBe(secondId);
	});
});
