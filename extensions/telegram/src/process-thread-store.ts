import type { ProcessEvent, ProcessInstance } from "@leitwerk-dev/domain";
import type { CoreServerSetupDeps } from "@leitwerk-dev/process-sdk";
import type { TelegramProcessThread } from "./types.js";

export const TELEGRAM_THREAD_LINKED_EVENT = "telegram.thread_linked";

function readThreadFromEvent(event: ProcessEvent): TelegramProcessThread | null {
	const data = event.data;
	return event.eventType === TELEGRAM_THREAD_LINKED_EVENT &&
		data.mode === "forum_topic" &&
		typeof data.chatId === "string" &&
		typeof data.messageThreadId === "number" &&
		typeof data.topicName === "string"
		? {
				mode: "forum_topic",
				chatId: data.chatId,
				messageThreadId: data.messageThreadId,
				topicName: data.topicName,
			}
		: null;
}

function newestFirst(events: readonly ProcessEvent[]): ProcessEvent[] {
	return [...events].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

type ProcessEventRepoWithTypedLookup = CoreServerSetupDeps["events"] & {
	listByInstanceEventTypes?: (
		instanceId: string,
		eventTypes: readonly string[],
		limit?: number,
	) => ProcessEvent[];
};

export function threadKey(chatId: string, messageThreadId: number | undefined): string {
	return `${chatId}:${messageThreadId ?? 0}`;
}

export class ProcessThreadStore {
	private readonly byInstanceId = new Map<string, TelegramProcessThread>();
	private readonly byThreadKey = new Map<string, string>();

	constructor(private readonly deps: Pick<CoreServerSetupDeps, "events" | "processes">) {}

	rebuildFromEvents(): readonly string[] {
		this.byInstanceId.clear();
		this.byThreadKey.clear();
		const mappedInstanceIds: string[] = [];

		for (const process of this.deps.processes.listAll()) {
			const linked = this.listThreadEvents(process.id).map(readThreadFromEvent).find(Boolean);
			if (linked) {
				this.remember(process.id, linked);
				mappedInstanceIds.push(process.id);
			}
		}

		return mappedInstanceIds;
	}

	getByInstanceId(instanceId: string): TelegramProcessThread | null {
		return this.byInstanceId.get(instanceId) ?? null;
	}

	getInstanceIdForThread(chatId: string, messageThreadId: number | undefined): string | null {
		return this.byThreadKey.get(threadKey(chatId, messageThreadId)) ?? null;
	}

	record(process: Pick<ProcessInstance, "id">, thread: TelegramProcessThread): void {
		this.deps.events.create({
			instanceId: process.id,
			eventType: TELEGRAM_THREAD_LINKED_EVENT,
			data: { ...thread },
		});
		this.remember(process.id, thread);
	}

	private listThreadEvents(instanceId: string): ProcessEvent[] {
		const events = this.deps.events as ProcessEventRepoWithTypedLookup;
		if (events.listByInstanceEventTypes) {
			return newestFirst(
				events.listByInstanceEventTypes(instanceId, [TELEGRAM_THREAD_LINKED_EVENT], 10_000),
			);
		}
		return newestFirst(
			events
				.listByInstance(instanceId, Number.MAX_SAFE_INTEGER)
				.filter((event) => event.eventType === TELEGRAM_THREAD_LINKED_EVENT),
		);
	}

	private remember(instanceId: string, thread: TelegramProcessThread): void {
		const previous = this.byInstanceId.get(instanceId);
		if (previous) this.byThreadKey.delete(threadKey(previous.chatId, previous.messageThreadId));
		this.byInstanceId.set(instanceId, thread);
		this.byThreadKey.set(threadKey(thread.chatId, thread.messageThreadId), instanceId);
	}
}
