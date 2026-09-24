import { describe, expect, it } from "vitest";
import { classifyDeliveryMode, deliverBatch, type InputItem } from "./input-consumer.js";

function createRecordingSession() {
	const prompts: string[] = [];
	const steers: string[] = [];
	return {
		prompts,
		steers,
		async prompt(body: string) {
			prompts.push(body);
			return {
				startLeafId: null,
				endLeafId: "mock-result",
				createdEntryIds: [],
				resultEntryId: "mock-result",
			};
		},
		async steer(body: string) {
			steers.push(body);
		},
	};
}

function item(overrides: Partial<InputItem> & Pick<InputItem, "inputId" | "sequence">): InputItem {
	return {
		source: "user",
		kind: "message",
		target: null,
		bodyMarkdown: "body",
		...overrides,
	};
}

describe("classifyDeliveryMode", () => {
	it('returns "steer" for system events even without an active turn', () => {
		expect(
			classifyDeliveryMode(item({ inputId: "a", sequence: 1, kind: "system_event" }), false),
		).toBe("steer");
	});
});

describe("deliverBatch", () => {
	it("delivers the first input according to turn state and the rest as steers", async () => {
		const session = createRecordingSession();
		const inputs = [
			item({ inputId: "1", sequence: 1, bodyMarkdown: "first" }),
			item({ inputId: "2", sequence: 2, bodyMarkdown: "second" }),
			item({ inputId: "3", sequence: 3, bodyMarkdown: "third" }),
		];
		const delivered = await deliverBatch(session, inputs, false);
		expect(delivered).toEqual([
			{ inputId: "1", sequence: 1, deliveryMode: "prompt" },
			{ inputId: "2", sequence: 2, deliveryMode: "steer" },
			{ inputId: "3", sequence: 3, deliveryMode: "steer" },
		]);
		expect(session.prompts).toEqual(["first"]);
		expect(session.steers).toEqual(["second", "third"]);
	});

	it("uses steer for the first input when a turn is already active", async () => {
		const session = createRecordingSession();
		const inputs = [
			item({ inputId: "1", sequence: 1, bodyMarkdown: "a" }),
			item({ inputId: "2", sequence: 2, bodyMarkdown: "b" }),
		];
		const delivered = await deliverBatch(session, inputs, true);
		expect(delivered[0].deliveryMode).toBe("steer");
		expect(session.prompts).toEqual([]);
		expect(session.steers).toEqual(["a", "b"]);
	});
});
