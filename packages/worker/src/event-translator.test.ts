import { describe, expect, it } from "vitest";
import { translatePiEvent } from "./event-translator.js";
import type { PiEvent } from "./pi-adapter.js";

describe("translatePiEvent", () => {
	it("prefixes Pi event types with pi.", () => {
		const base = {
			turnId: "t1",
			data: {},
			timestamp: "2026-01-01T00:00:00.000Z",
		};
		const types = [
			"turn.start",
			"turn.end",
			"stream.delta",
			"tool.call",
			"tool.update",
			"tool.result",
			"toolcall.start",
			"toolcall.delta",
			"toolcall.end",
			"compaction.start",
			"compaction.end",
			"label.changed",
			"error",
			"retry.start",
			"retry.end",
			"usage",
		] as const;
		for (const type of types) {
			const ev: PiEvent = { ...base, type };
			expect(translatePiEvent(ev, "idle").eventType).toBe(`pi.${type}`);
		}
	});

	it("includes turnId, timestamp, and event data", () => {
		const piEvent: PiEvent = {
			type: "stream.delta",
			turnId: "turn-42",
			timestamp: "2026-03-28T12:00:00.000Z",
			data: { text: "hello" },
		};
		const translated = translatePiEvent(piEvent, "responding");
		expect(translated.data).toEqual({
			turnId: "turn-42",
			timestamp: "2026-03-28T12:00:00.000Z",
			text: "hello",
		});
	});
});
