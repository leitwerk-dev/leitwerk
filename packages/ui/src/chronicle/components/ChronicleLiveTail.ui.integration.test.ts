/// <reference types="svelte" />
import type { TurnProgressStep } from "@leitwerk-dev/domain";
import { createTestQuestionRequest } from "@leitwerk-dev/test-support/fixtures";
import { tick } from "svelte";
import { describe, expect, it, vi } from "vitest";
import { mountTest } from "../../test-support/mount.js";
import type { ChronicleLiveTailItem } from "../lib/chronicle-projection.js";
import ChronicleLiveTail from "./ChronicleLiveTail.svelte";

function liveTail(overrides: Partial<ChronicleLiveTailItem> = {}): ChronicleLiveTailItem {
	return {
		kind: "live_tail",
		anchorId: "live-1",
		turnRecordId: "record-1",
		turnId: "investigate",
		turnType: "llm",
		title: "Investigate and draft · garden",
		turnLabel: "investigate",
		iteration: { runId: "run", itemKey: "garden", index: 0, count: 2, label: "garden" },
		pathLabel: null,
		state: "thinking",
		stateLabel: "Reasoning",
		copy: "Checking the watering schedule.",
		assistantTextPreview: "",
		reasoningSection: {
			kind: "thinking_preview",
			text: "Checking the watering schedule.",
			preview: "Checking the watering schedule.",
			previewTruncated: false,
			toolCallCount: 0,
			traceItemCount: 1,
		},
		toolCall: null,
		usage: null,
		eventWindowTruncated: false,
		modelProfileId: "sandbox",
		triggeringInput: null,
		piInput: null,
		facts: { startedAt: "2026-10-07T10:00:00Z", endedAt: null },
		progress: {
			// Older saved reports must not look like completed investigations either.
			title: "Investigating garden",
			steps: [{ id: "repo", label: "Garden repository", status: "completed" }],
		},
		...overrides,
	};
}

describe("live investigation progress", () => {
	it("shows the authored automatic activity once without fallback copy or an empty checklist", async () => {
		const summary = "Creating ticket 3 of 8: Frontend — Add deployment checks";
		const recordedAt = "2026-10-07T10:01:00Z";
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail({
				turnType: "automatic",
				state: "waiting",
				stateLabel: summary,
				activitySummary: summary,
				copy: "Current step: publish_tickets",
				reasoningSection: null,
				progress: { title: "Ticket publication", summary, steps: [] },
				progressRecordedAt: recordedAt,
			}),
			isFocused: false,
			onOpenReasoningDetails: vi.fn(),
		});
		await tick();
		expect(target.querySelector(".live-copy[role=status]")?.textContent).toContain(summary);
		expect(target.querySelector(".live-copy time")?.getAttribute("datetime")).toBe(recordedAt);
		expect(target.querySelector(".live-copy time")?.textContent).toContain("Updated");
		expect(target.querySelectorAll(".live-tail-body .live-copy")).toHaveLength(1);
		expect(target.querySelector(".sr-only[role=status]")?.textContent).toContain(summary);
		expect(target.textContent).not.toContain("Current step:");
		expect(target.textContent).not.toContain("Waiting for activity");
		expect(target.querySelector('[data-section="turn-progress"]')).toBeNull();
		expect(target.querySelector('[data-section="turn-progress-summary"]')).toBeNull();
	});

	it("retains optional progress steps without repeating the activity summary", async () => {
		const summary = "Publishing the approved changes";
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail({
				turnType: "automatic",
				state: "waiting",
				stateLabel: summary,
				activitySummary: summary,
				reasoningSection: null,
				progress: {
					title: "Delivery",
					summary,
					steps: [{ id: "publish", label: "Publish changes", status: "in_progress" }],
				},
			}),
			isFocused: false,
			onOpenReasoningDetails: vi.fn(),
		});
		await tick();
		expect(target.querySelector('[data-progress-step="publish"]')).not.toBeNull();
		expect(target.querySelector('[data-section="turn-progress-summary"]')).toBeNull();
	});

	it("keeps open questions paused even when an author supplied activity text", async () => {
		const summary = "Fetching evidence";
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail({
				state: "waiting",
				stateLabel: summary,
				activitySummary: summary,
				progress: { title: "Preparation", summary, steps: [] },
			}),
			questionRequests: [createTestQuestionRequest()],
			isFocused: false,
			onOpenReasoningDetails: vi.fn(),
		});
		await tick();
		expect(target.querySelector(".entry-timing")?.textContent).toContain("Paused");
		expect(target.querySelector(".live-copy[role=status]")).toBeNull();
		expect(target.textContent).toContain("Waiting for your answers");
	});

	it("moves a text-only preparation report below active reasoning", async () => {
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail({
				progress: { title: "Preparation", summary: "Fetched source evidence", steps: [] },
			}),
			isFocused: false,
			onOpenReasoningDetails: vi.fn(),
		});
		await tick();
		expect(target.querySelector(".reasoning-activity")).not.toBeNull();
		expect(target.querySelector(".live-copy[role=status]")).toBeNull();
		expect(
			target.querySelector('.live-footer [data-section="turn-progress-summary"]')?.textContent,
		).toContain("Fetched source evidence");
		expect(target.querySelector('[data-section="turn-progress"]')).toBeNull();
	});

	it.each([
		null,
		undefined,
		{ title: "Repository preparation", steps: [] },
	])("renders live work without a completed preparation report (%j)", async (progress) => {
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail({ progress }),
			isFocused: false,
			onOpenReasoningDetails: vi.fn(),
		});
		await tick();
		expect(target.querySelector(".entry-timing")?.textContent).toContain("Running");
		expect(target.textContent).not.toContain("Workspace prepared");
		expect(target.querySelector(".reasoning-activity")).not.toBeNull();
	});

	it("keeps the investigation running while completed preparation is a neutral footer disclosure", async () => {
		const onOpenReasoningDetails = vi.fn();
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail(),
			isFocused: false,
			onOpenReasoningDetails,
		});
		await tick();
		expect(target.querySelector("h3")?.textContent).toBe("Investigate and draft · garden");
		expect(target.querySelector(".entry-metadata")?.textContent).toContain("Item 1 of 2");
		expect(target.querySelector(".entry-timing")?.textContent).toContain("Running");
		expect(target.querySelectorAll(".reasoning-label")).toHaveLength(1);
		expect(target.querySelector(".live-copy[role=status]")).toBeNull();
		expect(target.querySelector(".reasoning-activity")).not.toBeNull();
		expect(target.querySelector('[data-section="thinking-preview"]')?.textContent).toContain(
			"Checking the watering schedule.",
		);
		const disclosure = target.querySelector<HTMLDetailsElement>(".live-footer details");
		expect(disclosure?.open).toBe(false);
		expect(disclosure?.querySelector("summary")?.textContent).toContain("Workspace prepared");
		expect(disclosure?.querySelector("summary .check")).toBeNull();
		expect(target.textContent).not.toContain("Investigating garden completed");
		disclosure?.querySelector("summary")?.click();
		expect(disclosure?.open).toBe(true);
		expect(disclosure?.querySelector('[data-progress-step="repo"]')?.textContent).toContain(
			"Garden repository",
		);
		target.querySelector<HTMLButtonElement>('[data-action="open-reasoning-details"]')?.click();
		expect(onOpenReasoningDetails).toHaveBeenCalledWith("record-1", "reasoning");
	});

	it.each<TurnProgressStep["status"]>([
		"in_progress",
		"failed",
		"incomplete",
		"skipped",
	])("keeps %s preparation visible in the body", async (status) => {
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail({
				progress: {
					title: "Repository preparation",
					steps: [{ id: "repo", label: "Garden repository", status }],
				},
			}),
			isFocused: false,
			onOpenReasoningDetails: vi.fn(),
		});
		await tick();
		expect(target.textContent).toContain("Repository preparation");
		expect(target.textContent).not.toContain("Workspace prepared");
		expect(target.querySelector(".live-footer [data-section=turn-progress]")).toBeNull();
		expect(target.querySelector(`[data-progress-status="${status}"]`)).not.toBeNull();
	});

	it.each([
		{ state: "tool_running", stateLabel: "Running action" },
		{ state: "streaming", stateLabel: "Writing response" },
		{ state: "waiting", stateLabel: "Waiting for activity" },
	] as const)("retains the $state status without marking prior reasoning active", async (state) => {
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail(state),
			isFocused: false,
			onOpenReasoningDetails: vi.fn(),
		});
		await tick();
		expect(target.querySelector(".live-copy[role=status]")?.textContent).toBe(state.stateLabel);
		expect(target.querySelector(".reasoning-activity")).toBeNull();
		expect(target.querySelector('[data-section="thinking-preview"]')).not.toBeNull();
	});

	it("pauses for a question without marking the retained preview as active reasoning", async () => {
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail(),
			questionRequests: [createTestQuestionRequest()],
			isFocused: false,
			onOpenReasoningDetails: vi.fn(),
		});
		await tick();
		expect(target.querySelector(".entry-timing")?.textContent).toContain("Paused");
		expect(target.querySelector(".reasoning-activity")).toBeNull();
		expect(target.textContent).toContain("Waiting for your answers");
	});

	it("keeps stopping the turn available after preparation completes", async () => {
		const onAbortTurn = vi.fn();
		const { target } = mountTest(ChronicleLiveTail, {
			liveTail: liveTail(),
			isFocused: false,
			onOpenReasoningDetails: vi.fn(),
			onAbortTurn,
		});
		await tick();
		target.querySelector<HTMLButtonElement>(".stop-trigger")?.click();
		await tick();
		expect(onAbortTurn).not.toHaveBeenCalled();
		target.querySelector<HTMLButtonElement>(".stop-confirm-btn")?.click();
		expect(onAbortTurn).toHaveBeenCalledOnce();
	});
});
