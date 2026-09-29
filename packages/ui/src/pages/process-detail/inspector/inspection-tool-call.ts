import type { InspectionTraceMessage, TurnTraceSnapshot } from "@leitwerk-dev/protocol";

/** Correlate retained outcomes without inferring success from a missing live projection. @internal */
export function inspectionToolCall(
	call: Extract<InspectionTraceMessage["blocks"][number]["content"], { type: "toolCall" }>,
	timestamp: string,
	messages: readonly InspectionTraceMessage[],
	live: TurnTraceSnapshot | null,
) {
	const recorded = live?.toolCalls.find((tool) => tool.toolCallId === call.id);
	if (recorded) return recorded;
	const result = messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === call.id,
	);
	return {
		toolCallId: call.id,
		toolName: call.name,
		arguments: call.arguments,
		status: result ? ("completed" as const) : ("unknown" as const),
		startedAt: timestamp,
		completedAt: result?.timestamp ?? null,
		resultText: result
			? result.blocks
					.flatMap((block) => (block.content.type === "text" ? [block.content.text] : []))
					.join("\n")
			: null,
		truncated: false,
		isError: result?.isError ?? false,
	};
}
