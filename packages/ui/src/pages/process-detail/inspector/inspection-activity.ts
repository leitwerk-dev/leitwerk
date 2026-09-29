import type { ProcessEvent } from "@leitwerk-dev/domain";
import type {
	ExecutionInspectionTrace,
	InspectionTraceMessage,
	TurnTraceSnapshot,
} from "@leitwerk-dev/protocol";

export type InspectionActivity =
	| { kind: "message"; id: string; timestamp: string; message: InspectionTraceMessage }
	| { kind: "event"; id: string; timestamp: string; event: ProcessEvent };
/** A presentation of the reconciler's ordered events, with durable message aliases. */
export function inspectionActivity(
	trace: ExecutionInspectionTrace,
	events: readonly ProcessEvent[],
	live: TurnTraceSnapshot | null,
): InspectionActivity[] {
	const messages = [...trace.messages];
	const aliases = new Set(messages.flatMap((m) => m.aliases));
	const streamed: InspectionTraceMessage[] = [];
	const operations: InspectionActivity[] = [];
	let assistant: InspectionTraceMessage | null = null;
	let previousTurn: unknown;
	for (const event of events) {
		const id = `event:${event.eventSequence ?? event.id}`;
		const data = event.data;
		const type = event.eventType;
		if (type === "pi.stream.delta") {
			if (aliases.has(id)) continue;
			if (!assistant || previousTurn !== data.turnId) {
				assistant = {
					id,
					entryId: null,
					aliases: [],
					role: "assistant",
					timestamp: event.createdAt,
					blocks: [],
					toolCallId: null,
					toolName: null,
					isError: false,
				};
				streamed.push(assistant);
			}
			previousTurn = data.turnId;
			assistant.aliases.push(id);
			const text = typeof data.text === "string" ? data.text : "";
			const thinking = data.streamType === "thinking";
			const last = assistant.blocks.at(-1)?.content;
			if (thinking && last?.type === "thinking") last.thinking += text;
			else if (!thinking && last?.type === "text") last.text += text;
			else
				assistant.blocks.push({
					id,
					content: thinking ? { type: "thinking", thinking: text } : { type: "text", text },
				});
		} else if (
			["pi.tool.call", "pi.tool.started", "pi.tool.result", "pi.tool.completed"].includes(type)
		) {
			assistant = null;
			if (aliases.has(id)) continue;
			const tool = live?.toolCalls.find((tool) => tool.toolCallId === data.toolCallId);
			if (!tool) continue;
			const result = type === "pi.tool.result" || type === "pi.tool.completed";
			streamed.push({
				id,
				entryId: null,
				aliases: [],
				role: result ? "toolResult" : "assistant",
				timestamp: event.createdAt,
				blocks: [
					{
						id: `${id}:content`,
						content: result
							? { type: "text", text: tool.resultText ?? "Result not recorded" }
							: {
									type: "toolCall",
									id: tool.toolCallId,
									name: tool.toolName,
									arguments: tool.arguments ?? {},
								},
					},
				],
				toolCallId: result ? tool.toolCallId : null,
				toolName: result ? tool.toolName : null,
				isError: tool.isError,
			});
		} else if (
			!type.endsWith("usage") &&
			!["pi.turn.start", "pi.turn.end", "pi.stream.started", "pi.stream.completed"].includes(type)
		) {
			operations.push({ kind: "event", id, timestamp: event.createdAt, event });
		} else assistant = null;
	}
	const result: InspectionActivity[] = [...messages, ...streamed].map((message) => ({
		kind: "message" as const,
		id: message.id,
		timestamp: message.timestamp,
		message,
	}));
	const selected = trace.target?.state === "available" ? trace.target.itemId : null;
	if (
		selected?.startsWith("event:") &&
		![...result, ...operations].some(
			(item) =>
				item.id === selected ||
				(item.kind === "message" && item.message.aliases.includes(selected)),
		)
	) {
		const event = events.find((event) => `event:${event.eventSequence}` === selected);
		if (event) operations.push({ kind: "event", id: selected, timestamp: event.createdAt, event });
	}
	const sequence = (item: InspectionActivity) =>
		item.id.startsWith("event:") ? Number(item.id.slice(6)) : null;
	return [...result, ...operations].sort((a, b) => {
		const left = sequence(a),
			right = sequence(b);
		return left !== null && right !== null ? left - right : a.timestamp.localeCompare(b.timestamp);
	});
}
