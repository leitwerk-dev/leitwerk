import type { ProcessEvent } from "@leitwerk-dev/domain";
import type { ExecutionInspectionTrace } from "@leitwerk-dev/protocol";
import { expect, it } from "vitest";
import { inspectionActivity } from "./inspection-activity.js";

const trace: ExecutionInspectionTrace = {
	instanceId: "process",
	turnRecordId: "turn",
	state: "live",
	throughEventSequence: 0,
	sessionSignature: null,
	reasoning: {
		assistant: { text: "", thinking: "", lastUpdatedAt: null },
		toolCalls: [],
		traceItems: [],
		usage: null,
		piInput: null,
	},
	events: [],
	messages: [],
	annotations: [],
	output: null,
	target: null,
	inheritedBoundary: null,
};
const delta = (eventSequence: number, streamType: string, text: string): ProcessEvent => ({
	id: `event-${eventSequence}`,
	eventSequence,
	instanceId: "process",
	eventType: "pi.stream.delta",
	data: { text, streamType, turnId: "call-1" },
	createdAt: `2026-01-01T00:00:0${eventSequence}Z`,
});
it("keeps live message blocks in their recorded order and links each event to its message", () => {
	const activity = inspectionActivity(
		trace,
		[delta(1, "thinking", "First"), delta(2, "text", "Answer"), delta(3, "thinking", "Reconsider")],
		null,
	);
	expect(activity).toHaveLength(1);
	expect(activity[0]).toMatchObject({
		id: "event:1",
		message: {
			role: "assistant",
			aliases: ["event:1", "event:2", "event:3"],
			blocks: [
				{ id: "event:1", content: { type: "thinking", thinking: "First" } },
				{ id: "event:2", content: { type: "text", text: "Answer" } },
				{ id: "event:3", content: { type: "thinking", thinking: "Reconsider" } },
			],
		},
	});
});
it("replaces live aliases with the committed message and retains uncorrelated event links explicitly", () => {
	const committed: ExecutionInspectionTrace = {
		...trace,
		state: "committed",
		messages: [
			{
				id: "entry:a",
				entryId: "a",
				aliases: ["event:1"],
				role: "assistant",
				timestamp: "2026-01-01T00:00:01Z",
				blocks: [{ id: "block:a", content: { type: "text", text: "Committed" } }],
				toolCallId: null,
				toolName: null,
				isError: false,
			},
		],
		target: null,
	};
	const activity = inspectionActivity(
		committed,
		[delta(1, "text", "Committed"), delta(2, "thinking", "Uncorrelated")],
		null,
	);
	expect(activity.map((item) => item.id)).toEqual(["entry:a", "event:2"]);
});

it("orders durable activity by event sequence when timestamps coincide", () => {
	const earlier = { ...delta(1, "text", "Before"), eventType: "pi.error" };
	const later = { ...delta(2, "text", "After"), createdAt: earlier.createdAt };
	expect(inspectionActivity(trace, [earlier, later], null).map((item) => item.id)).toEqual([
		"event:1",
		"event:2",
	]);
});
