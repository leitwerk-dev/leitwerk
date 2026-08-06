import type { ProcessEvent, ProcessInstance } from "@leitwerk-dev/domain";
import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import { ProcessThreadStore, TELEGRAM_THREAD_LINKED_EVENT } from "./process-thread-store.js";

function event(input: {
	instanceId: string;
	eventType: string;
	createdAt: string;
	data?: Record<string, unknown>;
}): ProcessEvent {
	return {
		id: `evt_${input.createdAt}_${input.eventType}`,
		instanceId: input.instanceId,
		eventType: input.eventType,
		data: input.data ?? {},
		createdAt: input.createdAt,
	};
}

function threadEvent(process: ProcessInstance, createdAt: string, messageThreadId: number) {
	return event({
		instanceId: process.id,
		eventType: TELEGRAM_THREAD_LINKED_EVENT,
		createdAt,
		data: { mode: "forum_topic", chatId: "-100", messageThreadId, topicName: "topic" },
	});
}

function newestFirst(events: readonly ProcessEvent[]): ProcessEvent[] {
	return [...events].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function createStoreHarness(input: {
	processes: readonly ProcessInstance[];
	events: readonly ProcessEvent[];
}) {
	const storedEvents = [...input.events];
	const store = new ProcessThreadStore({
		processes: {
			create: () => {
				throw new Error("not used");
			},
			getById: (id) => input.processes.find((process) => process.id === id) ?? null,
			listAll: () => [...input.processes],
		},
		events: {
			create: (created) => {
				storedEvents.push(
					event({
						instanceId: created.instanceId,
						eventType: created.eventType,
						createdAt: "2026-05-15T00:00:00.000Z",
						data: created.data,
					}),
				);
			},
			listByInstance: (instanceId, limit = 100) =>
				newestFirst(storedEvents.filter((candidate) => candidate.instanceId === instanceId)).slice(
					0,
					limit,
				),
			listByInstanceEventTypes: (instanceId: string, eventTypes: readonly string[], limit = 100) =>
				newestFirst(
					storedEvents.filter(
						(candidate) =>
							candidate.instanceId === instanceId && eventTypes.includes(candidate.eventType),
					),
				).slice(0, limit),
		},
	});
	return { store, storedEvents };
}

describe("ProcessThreadStore", () => {
	it("rebuilds the latest persisted process-topic mapping", () => {
		const process = createTestProcessInstance({ id: "agt_1" });
		const { store } = createStoreHarness({
			processes: [process],
			events: [
				threadEvent(process, "2026-05-15T09:00:00.000Z", 10),
				threadEvent(process, "2026-05-15T10:00:00.000Z", 20),
			],
		});

		expect(store.rebuildFromEvents()).toEqual([process.id]);
		expect(store.getByInstanceId(process.id)).toMatchObject({ messageThreadId: 20 });
		expect(store.getInstanceIdForThread("-100", 20)).toBe(process.id);
		expect(store.getInstanceIdForThread("-100", 10)).toBeNull();
	});

	it("rebuilds mappings that are older than the generic process-event window", () => {
		const process = createTestProcessInstance({ id: "agt_many_events" });
		const noise = Array.from({ length: 10_050 }, (_, index) =>
			event({
				instanceId: process.id,
				eventType: "pi.stream.delta",
				createdAt: new Date(Date.UTC(2026, 4, 16, 0, 0, index)).toISOString(),
				data: { index },
			}),
		);
		const { store } = createStoreHarness({
			processes: [process],
			events: [threadEvent(process, "2026-05-15T09:00:00.000Z", 882), ...noise],
		});

		expect(store.rebuildFromEvents()).toEqual([process.id]);
		expect(store.getByInstanceId(process.id)).toMatchObject({ messageThreadId: 882 });
		expect(store.getInstanceIdForThread("-100", 882)).toBe(process.id);
	});

	it("removes stale thread routing when a process is re-linked", () => {
		const process = createTestProcessInstance({ id: "agt_4" });
		const { store } = createStoreHarness({ processes: [process], events: [] });

		store.record(process, {
			mode: "forum_topic",
			chatId: "-100",
			messageThreadId: 40,
			topicName: "old",
		});
		store.record(process, {
			mode: "forum_topic",
			chatId: "-100",
			messageThreadId: 41,
			topicName: "new",
		});

		expect(store.getInstanceIdForThread("-100", 40)).toBeNull();
		expect(store.getInstanceIdForThread("-100", 41)).toBe(process.id);
	});
});
