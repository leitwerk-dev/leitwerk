// @vitest-environment jsdom

import type { ProcessStartupSummary } from "@leitwerk-dev/protocol";
import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import ChronicleStartupHistory from "../chronicle/components/ChronicleStartupHistory.svelte";
import ChronicleTurnProgress from "../chronicle/components/ChronicleTurnProgress.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];

afterEach(async () => {
	await Promise.all(mounted.splice(0).map((component) => unmount(component)));
	document.body.innerHTML = "";
});

describe("Process checklists", () => {
	it("preserves step order and states with the same rows in startup and workspace preparation", () => {
		const target = document.createElement("div");
		document.body.appendChild(target);
		const startup: ProcessStartupSummary = {
			authoritativeAttemptId: "start-1",
			recovery: null,
			attempts: [
				{
					startRecordId: "start-1",
					workerLeaseId: null,
					status: "failed",
					startedAt: "2026-09-10T00:00:00Z",
					readyAt: null,
					durationMs: 2_000,
					summary: "Workspace preparation failed.",
					recoveredByStartRecordId: null,
					steps: [
						{ id: "start_worker", label: "Start worker", status: "completed", occurredAt: null },
						{
							id: "connect_worker",
							label: "Connect worker",
							status: "in_progress",
							occurredAt: null,
						},
						{
							id: "prepare_workspace",
							label: "Prepare workspace",
							status: "failed",
							occurredAt: null,
						},
						{
							id: "start_first_turn",
							label: "Start first turn",
							status: "pending",
							occurredAt: null,
						},
					],
				},
			],
		};
		mounted.push(mount(ChronicleStartupHistory, { target, props: { startup } }));
		mounted.push(
			mount(ChronicleTurnProgress, {
				target,
				props: {
					report: {
						title: "LLM workspace preparation",
						steps: startup.attempts[0].steps.map((step) => ({
							id: step.id,
							label: step.label,
							status:
								step.status === "pending" || step.status === "superseded"
									? "incomplete"
									: step.status,
							detail: step.id === "prepare_workspace" ? "Repository unavailable." : undefined,
						})),
					},
				},
			}),
		);

		const lists = [...target.querySelectorAll("ol")];
		expect(lists).toHaveLength(2);
		for (const list of lists) {
			expect([...list.querySelectorAll(".step-label")].map((row) => row.textContent)).toEqual([
				"Start worker",
				"Connect worker",
				"Prepare workspace",
				"Start first turn",
			]);
			expect(
				[...list.querySelectorAll(".status-label")].slice(0, 3).map((row) => row.textContent),
			).toEqual(["Complete", "In progress", "Failed"]);
			expect(list.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(4);
		}
		expect(target.textContent).toContain("Pending");
		expect(target.textContent).toContain("Incomplete");
		expect(target.textContent).toContain("Workspace preparation failed.");
		expect(target.textContent).toContain("Repository unavailable.");
		const headings = [...target.querySelectorAll("h3, h4")];
		expect(headings.map((heading) => heading.textContent)).toEqual([
			"Process startup failed",
			"LLM workspace preparation",
		]);
		expect(new Set(headings.map((heading) => heading.id)).size).toBe(headings.length);
	});
});
