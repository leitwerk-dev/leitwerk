import type { PiEventHandler, PiTreeHandle, PiTreeNode } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import {
	classifyDeliveryMode,
	deliverBatch,
	deliverInput,
	filterInputsAfterConsumedSequence,
	type InputItem,
} from "./input-consumer.js";

function createMockSession(): PiTreeHandle & {
	prompts: string[];
	steers: string[];
} {
	const prompts: string[] = [];
	const steers: string[] = [];
	return {
		sessionId: "mock-session",
		treeFile: "/mock/session.json",
		isResumed: false,
		prompts,
		steers,
		getRunDetails() {
			return {
				loadedAgentsFiles: [],
				loadedSkills: [],
				availableToolNames: ["read", "bash", "edit", "write"],
			};
		},
		getLeafId() {
			return null;
		},
		getEntry() {
			return undefined;
		},
		getBranch() {
			return [];
		},
		getChildren() {
			return [];
		},
		getTree() {
			return [] as PiTreeNode[];
		},
		async branch() {},
		async branchFromRoot() {},
		async resetLeaf() {},
		async prompt(body: string) {
			prompts.push(body);
			return {
				startLeafId: null,
				endLeafId: "mock-result",
				createdEntryIds: [],
				resultEntryId: "mock-result",
			};
		},
		async continueTurn() {
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
		async abortTurn() {},
		subscribe(_handler: PiEventHandler) {
			return () => {};
		},
		async close() {},
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

describe("filterInputsAfterConsumedSequence", () => {
	it("drops redelivered inputs at or below the consumed sequence and keeps newer inputs", () => {
		const inputs = [
			item({ inputId: "already-1", sequence: 1 }),
			item({ inputId: "already-2", sequence: 2 }),
			item({ inputId: "new-3", sequence: 3 }),
		];

		expect(filterInputsAfterConsumedSequence(inputs, 2).map((input) => input.inputId)).toEqual([
			"new-3",
		]);
	});
});

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
		const session = createMockSession();
		await deliverInput(
			session,
			item({ inputId: "i1", sequence: 1, bodyMarkdown: "hello" }),
			"prompt",
		);
		expect(session.prompts).toEqual(["hello"]);
		expect(session.steers).toEqual([]);
	});

	it("calls session.steer for steer mode", async () => {
		const session = createMockSession();
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
		const session = createMockSession();
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
		const session = createMockSession();
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
