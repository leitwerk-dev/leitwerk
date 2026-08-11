import { type Actor, ADMIN_ACTOR, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { createWrites, stampActorOnEvents, stampActorOnQueuedInputs } from "./writes.js";

const CHANNEL_ACTOR: Actor = {
	id: "channel",
	kind: "channel",
	provider: "test_channel",
};

describe("stampActorOnEvents", () => {
	it("stamps the actor onto every matching event and reports the count", () => {
		const writes = createWrites({
			events: [
				{ instanceId: "agt_1", eventType: "retry_scheduled", data: { attempt: 2 } },
				{ instanceId: "agt_1", eventType: "turn_selected", data: {} },
				{ instanceId: "agt_1", eventType: "retry_scheduled", data: {} },
			],
		});

		const stamped = stampActorOnEvents(writes, ADMIN_ACTOR, "retry_scheduled");

		expect(stamped).toBe(2);
		const retryEvents = writes.events.filter((event) => event.eventType === "retry_scheduled");
		expect(retryEvents.map((event) => event.data?.actor)).toEqual([ADMIN_ACTOR, ADMIN_ACTOR]);
		// Preserves existing data fields when stamping.
		expect(retryEvents[0]?.data).toMatchObject({ attempt: 2 });
		// Leaves non-matching events untouched.
		const selectionEvent = writes.events.find((event) => event.eventType === "turn_selected");
		expect(selectionEvent?.data).not.toHaveProperty("actor");
	});

	it("falls back to the system actor when none is supplied", () => {
		const writes = createWrites({
			events: [{ instanceId: "agt_1", eventType: "process_aborted", data: {} }],
		});

		stampActorOnEvents(writes, undefined, "process_aborted");

		expect(writes.events[0]?.data?.actor).toEqual(SYSTEM_ACTOR);
	});

	it("returns zero when no event matches, surfacing a silent no-op", () => {
		const writes = createWrites({
			events: [{ instanceId: "agt_1", eventType: "turn_selected", data: {} }],
		});

		const stamped = stampActorOnEvents(writes, ADMIN_ACTOR, "process_action_executed");

		expect(stamped).toBe(0);
	});
});

describe("stampActorOnQueuedInputs", () => {
	it("stamps the actor only onto inputs that lack one", () => {
		const writes = createWrites({
			queuedInputs: [
				{ source: "action_prompt", kind: "instruction", bodyMarkdown: "follow up" },
				{
					source: "external_comment",
					kind: "instruction",
					bodyMarkdown: "from chat",
					actor: CHANNEL_ACTOR,
				},
			],
		});

		stampActorOnQueuedInputs(writes, ADMIN_ACTOR);

		expect(writes.queuedInputs[0]?.actor).toEqual(ADMIN_ACTOR);
		// A pre-existing per-input actor is preserved over the command-level default.
		expect(writes.queuedInputs[1]?.actor).toEqual(CHANNEL_ACTOR);
	});

	it("is a no-op when no actor is supplied", () => {
		const writes = createWrites({
			queuedInputs: [{ source: "action_prompt", kind: "instruction", bodyMarkdown: "follow up" }],
		});

		stampActorOnQueuedInputs(writes, undefined);

		expect(writes.queuedInputs[0]?.actor).toBeUndefined();
	});
});
