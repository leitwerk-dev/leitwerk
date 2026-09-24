import { describe, expect, it } from "vitest";
import { mapWorkerEventToWsType } from "./protocol.js";
import { isStreamableEvent } from "./streamable-events.js";

describe("browser-projected worker events", () => {
	it.each([
		["pi.stream.delta", "pi.stream.delta"],
		["pi.turn.start", "pi.stream.started"],
		["pi.turn.end", "pi.stream.completed"],
		["pi.tool.call", "pi.tool.started"],
		["pi.tool.result", "pi.tool.completed"],
		["pi.label.changed", "pi.label.changed"],
		["pi.error", "pi.error"],
		["pi.retry.start", "pi.retry.start"],
		["pi.retry.end", "pi.retry.end"],
		["pi.usage", "pi.usage"],
		["pi.compaction.start", "pi.compaction.start"],
		["pi.compaction.end", "pi.compaction.end"],
	])("streams %s as %s", (workerType, browserType) => {
		expect(isStreamableEvent(workerType)).toBe(true);
		expect(mapWorkerEventToWsType(workerType)).toBe(browserType);
	});

	it.each([
		"worker.trace",
		"pi.tool.update",
		"pi.unknown_future_event",
	])("does not stream %s", (eventType) => {
		expect(isStreamableEvent(eventType)).toBe(false);
	});
});
