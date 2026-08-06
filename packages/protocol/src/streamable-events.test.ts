import { describe, expect, it } from "vitest";
import { mapWorkerEventToWsType } from "./protocol.js";
import { isStreamableEvent, STREAMABLE_WORKER_EVENT_TYPES } from "./streamable-events.js";

describe("isStreamableEvent", () => {
	it("accepts the browser-projected Pi event subset", () => {
		expect(isStreamableEvent("pi.stream.delta")).toBe(true);
		expect(isStreamableEvent("pi.tool.call")).toBe(true);
		expect(isStreamableEvent("pi.usage")).toBe(true);
	});

	it("rejects diagnostics and non-streamed Pi events", () => {
		expect(isStreamableEvent("worker.trace")).toBe(false);
		expect(isStreamableEvent("pi.tool.update")).toBe(false);
		expect(isStreamableEvent("pi.unknown_future_event")).toBe(false);
	});

	it("keeps streamability and worker-to-WebSocket mapping in parity", () => {
		for (const eventType of STREAMABLE_WORKER_EVENT_TYPES) {
			expect(isStreamableEvent(eventType)).toBe(true);
			expect(mapWorkerEventToWsType(eventType)).not.toBeNull();
		}
	});
});
