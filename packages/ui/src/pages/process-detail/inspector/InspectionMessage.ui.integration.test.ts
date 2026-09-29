import type { InspectionTraceMessage } from "@leitwerk-dev/protocol";
import { mount, tick, unmount } from "svelte";
import { expect, it } from "vitest";
import InspectionMessage from "./InspectionMessage.svelte";

it.each([
	"failed",
	"completed",
	"unknown",
] as const)("shows a retained tool's %s outcome without live activity", async (outcome) => {
	const call: InspectionTraceMessage = {
		id: "entry:call",
		entryId: "call",
		aliases: [],
		role: "assistant",
		timestamp: "2026-09-01T12:00:00Z",
		toolCallId: null,
		toolName: null,
		isError: false,
		blocks: [
			{
				id: "block:call",
				content: { type: "toolCall", id: "tool", name: "bash", arguments: { command: "false" } },
			},
		],
	};
	const result: InspectionTraceMessage = {
		id: "entry:result",
		entryId: "result",
		aliases: [],
		role: "toolResult",
		timestamp: "2026-09-01T12:00:01Z",
		toolCallId: "tool",
		toolName: "bash",
		isError: outcome === "failed",
		blocks: [{ id: "block:result", content: { type: "text", text: "Recorded result" } }],
	};
	const target = document.createElement("div");
	document.body.append(target);
	const app = mount(InspectionMessage, {
		target,
		props: { message: call, messages: outcome === "unknown" ? [call] : [call, result] },
	});
	try {
		await tick();
		const tool = target.querySelector<HTMLDetailsElement>("[data-tool-name='bash']");
		expect(tool?.dataset.toolStatus).toBe(outcome);
		expect(tool?.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
			outcome === "failed"
				? "Failed"
				: outcome === "unknown"
					? "Outcome not recorded"
					: "Completed",
		);
		if (!tool) throw new Error("Expected the retained tool call");
		tool.open = true;
		tool.dispatchEvent(new Event("toggle"));
		await tick();
		if (outcome === "unknown") {
			expect(tool.textContent).toContain("Duration Unknown");
			expect(tool.textContent).not.toContain("Completed");
		} else expect(tool.textContent).toContain("Recorded result");
	} finally {
		await unmount(app);
		target.remove();
	}
});
