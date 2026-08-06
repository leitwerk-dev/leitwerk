export const STREAMABLE_WORKER_EVENT_TYPES = [
	"pi.stream.delta",
	"pi.turn.start",
	"pi.turn.end",
	"pi.tool.call",
	"pi.tool.result",
	"pi.label.changed",
	"pi.error",
	"pi.retry.start",
	"pi.retry.end",
	"pi.usage",
] as const;

export type StreamableWorkerEventType = (typeof STREAMABLE_WORKER_EVENT_TYPES)[number];

const STREAMABLE_EVENT_TYPES = new Set<string>(STREAMABLE_WORKER_EVENT_TYPES);

export function isStreamableEvent(eventType: string): eventType is StreamableWorkerEventType {
	return STREAMABLE_EVENT_TYPES.has(eventType);
}
