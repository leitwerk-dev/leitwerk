import { describe, expect, it } from "vitest";
import {
	classifyDeliveryMode,
	deliverBatch,
	deliverInput,
	type InputItem,
} from "./input-consumer.js";

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
	it('returns "prompt" when there is no active turn', () => {
		expect(classifyDeliveryMode(item({ inputId: "a", sequence: 1, kind: "message" }), false)).toBe(
			"prompt",
		);
	});

	it('returns "steer" when a turn is active', () => {
		expect(classifyDeliveryMode(item({ inputId: "a", sequence: 1, kind: "message" }), true)).toBe(
			"steer",
		);
	});

	it('returns "steer" for system events even without an active turn', () => {
		expect(
			classifyDeliveryMode(item({ inputId: "a", sequence: 1, kind: "system_event" }), false),
		).toBe("steer");
	});
});

describe("deliverInput", () => {
	it("calls session.prompt for prompt mode", async () => {
		const session = createRecordingSession();
		await deliverInput(
			session,
			item({ inputId: "i1", sequence: 1, bodyMarkdown: "hello" }),
			"prompt",
		);
		expect(session.prompts).toEqual(["hello"]);
		expect(session.steers).toEqual([]);
	});

	it("calls session.steer for steer mode", async () => {
		const session = createRecordingSession();
		await deliverInput(
			session,
			item({ inputId: "i2", sequence: 2, bodyMarkdown: "hint" }),
			"steer",
		);
		expect(session.steers).toEqual(["hint"]);
		expect(session.prompts).toEqual([]);
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
