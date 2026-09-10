/// <reference types="svelte" />
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChronicleTurnClusterItem } from "../lib/chronicle-projection.js";
import ChronicleTurnCluster from "./ChronicleTurnCluster.svelte";

const mounted: ReturnType<typeof mount>[] = [];
const onOpenReasoningDetails = vi.fn();
const onDraftTicket = vi.fn();
function cluster(overrides: Partial<ChronicleTurnClusterItem> = {}): ChronicleTurnClusterItem {
	return {
		kind: "turn_cluster",
		chronologyAt: "2026-09-10T10:00:00Z",
		anchorId: "turn-1",
		turnRecordId: "record-1",
		turnId: "plan",
		turnType: "llm",
		title: "Plan",
		turnLabel: "plan",
		pathLabel: null,
		createdAt: "2026-09-10T10:00:00Z",
		preview: "Update the garden notes.",
		isOperatorDecision: false,
		turnPresentation: "llm_turn",
		turnKindLabel: "LLM turn",
		terminalStatus: null,
		sections: [{ kind: "turn_result", markdown: "Update the garden notes." }],
		modelProfileId: "sandbox",
		usage: null,
		triggeringInput: null,
		piInput: null,
		facts: {
			startedAt: "2026-09-10T10:00:00Z",
			endedAt: "2026-09-10T10:00:03.400Z",
			triggerSource: "user_action",
			runMode: "immediate",
			activeToolNames: [],
		},
		...overrides,
	};
}
async function render(value: ChronicleTurnClusterItem, compressHistory = false) {
	const target = document.createElement("div");
	document.body.appendChild(target);
	mounted.push(
		mount(ChronicleTurnCluster, {
			target,
			props: {
				cluster: value,
				isFocused: false,
				compressHistory,
				onOpenReasoningDetails,
				onDraftTicket,
			},
		}),
	);
	await tick();
	return target;
}
afterEach(async () => {
	for (const app of mounted.splice(0)) await unmount(app);
	document.body.replaceChildren();
	vi.clearAllMocks();
});

describe("chronicle turn disclosure", () => {
	it("shows the full short result without empty prompt or reasoning panels and keeps issue creation attached to that result", async () => {
		const target = await render(cluster(), true);
		expect(target.querySelector('[data-section="turn-result"]')?.textContent).toContain(
			"Update the garden notes.",
		);
		expect(target.querySelector('[data-section="turn-prompt"]')).toBeNull();
		expect(target.querySelector('[data-section="thinking-preview"]')).toBeNull();
		expect(target.querySelector("[popover]")).toBeNull();
		target.querySelector<HTMLButtonElement>('[data-action="open-turn-details"]')?.click();
		expect(onOpenReasoningDetails).toHaveBeenCalledWith("record-1");
		target.querySelector<HTMLButtonElement>(".create-issue-button")?.click();
		expect(onDraftTicket).toHaveBeenCalledWith({ kind: "turn_result", turnRecordId: "record-1" });
	});

	it("expands and collapses structured results in place while keeping reasoning behind its own control", async () => {
		const result = `## Plan\n\n${"Keep the scope focused. ".repeat(20)}\n\n- Validate the rendered notes.\n- Preserve the watering schedule.`;
		const target = await render(
			cluster({
				sections: [
					{ kind: "turn_result", markdown: result },
					{
						kind: "thinking_preview",
						text: "Consider the existing schedule first.",
						preview: "Consider the existing schedule first.",
						previewTruncated: false,
						items: [],
						toolCallCount: 0,
						traceItemCount: 1,
					},
				],
			}),
			true,
		);
		expect(target.textContent).not.toContain("Preserve the watering schedule.");
		expect(target.textContent).not.toContain("Consider the existing schedule first.");
		const reasoningSection = target.querySelector(".thinking-section");
		const turnDetails = target.querySelector('[data-action="open-turn-details"]');
		if (!reasoningSection || !turnDetails) throw new Error("Expected reasoning and turn details");
		expect(reasoningSection.compareDocumentPosition(turnDetails)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
		const toggle = target.querySelector<HTMLButtonElement>(
			".result-header-row .chronicle-expand-button",
		);
		toggle?.click();
		await tick();
		expect(target.querySelectorAll('[data-section="turn-result"] li')).toHaveLength(2);
		target.querySelector<HTMLButtonElement>('[data-action="open-reasoning-details"]')?.click();
		expect(onOpenReasoningDetails).toHaveBeenCalledWith("record-1");
		toggle?.click();
		await tick();
		expect(target.querySelector('[data-section="turn-result"] li')).toBeNull();
	});

	it("opens the actual prompt independently of the result and shows reported cost without token counters", async () => {
		const target = await render(
			cluster({
				piInput: {
					fullPrompt: "Update the watering notes.",
					parts: [],
					createdAt: "2026-09-10T10:00:00Z",
					userInput: null,
				},
				usage: {
					input: 4200,
					output: 300,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 4500,
					cost: { input: 0.02, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.03 },
				},
			}),
		);
		expect(target.querySelector(".entry-metadata")?.textContent).toBe("sandbox · $0.03");
		expect(target.textContent).not.toContain("4200");
		expect(target.querySelector(".entry-timing")?.textContent).toContain("3.4s");
		target.querySelector<HTMLButtonElement>('[data-section="turn-prompt"]')?.click();
		expect(onOpenReasoningDetails).toHaveBeenCalledWith("record-1");
		expect(target.querySelector('[data-section="turn-result"]')?.textContent).toContain(
			"Update the garden notes.",
		);
	});
});
