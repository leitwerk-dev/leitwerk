// @vitest-environment jsdom

import type { TurnProgressReport } from "@leitwerk-dev/domain";
import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import ChronicleTurnProgress from "./ChronicleTurnProgress.svelte";

let mounted: ReturnType<typeof mount> | null = null;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = null;
	document.body.replaceChildren();
});

describe("ChronicleTurnProgress", () => {
	it("renders a recorded text-only report and related links without an empty checklist", () => {
		const report: TurnProgressReport = {
			title: "Ticket publication",
			summary: "Published the approved tickets",
			steps: [],
			links: [{ id: "ticket", label: "TASK-101", url: "https://tracker.test/TASK-101" }],
		};
		mounted = mount(ChronicleTurnProgress, { target: document.body, props: { report } });
		expect(document.querySelector('[data-section="turn-progress-summary"]')?.textContent).toBe(
			report.summary,
		);
		expect(document.querySelector("a")?.textContent).toContain("TASK-101");
		expect(document.querySelector('[data-section="turn-progress"]')).toBeNull();
	});

	it("uses shared external links while preserving change types", () => {
		const report: TurnProgressReport = {
			title: "Publish changes",
			steps: [{ id: "publish", label: "Publish", status: "completed" }],
			links: [
				{
					id: "pr-12",
					label: "PR #12",
					url: "https://codehost.example/team/repo/pulls/12",
					kind: "pull_request",
				},
				{
					id: "notes",
					label: "Release notes",
					url: "https://docs.example/releases/12",
				},
			],
		};
		mounted = mount(ChronicleTurnProgress, { target: document.body, props: { report } });

		const links = [...document.querySelectorAll<HTMLAnchorElement>("a.external-link")];
		expect(links).toHaveLength(2);
		expect(links[0]?.getAttribute("aria-label")).toBe("Pull request: PR #12 (opens in a new tab)");
		expect(links[1]?.getAttribute("aria-label")).toBe(
			"External resource: Release notes (opens in a new tab)",
		);
		expect(links.every((link) => link.rel === "noopener noreferrer")).toBe(true);
	});
});
