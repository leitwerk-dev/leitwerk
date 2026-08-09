import { createEventBus } from "@leitwerk-dev/process-sdk";
import {
	createWorkerRuntime,
	type WorkerRuntimeAdapters,
	type WorkerRuntimeConfig,
	type WorkerRuntimeScheduler,
} from "@leitwerk-dev/worker";
import {
	createIpcMessage,
	type ServerToWorkerMessage,
	type WorkerStartPayload,
	type WorkerToServerMessage,
} from "@leitwerk-dev/worker-protocol";

type Timer = ReturnType<typeof setTimeout>;
type ServerMessageType = ServerToWorkerMessage["type"];
type ServerMessagePayloadByType = {
	[T in ServerMessageType]: Extract<ServerToWorkerMessage, { type: T }>["payload"];
};
type WorkerMessageType = WorkerToServerMessage["type"];
type WorkerMessageByType<T extends WorkerMessageType> = Extract<WorkerToServerMessage, { type: T }>;
type MessageWaiter = {
	type: WorkerMessageType;
	count: number;
	resolve(message: WorkerToServerMessage): void;
};

type Scheduled = {
	id: number;
	dueAt: number;
	handler(): void;
};

export interface ManualWorkerRuntimeScheduler extends WorkerRuntimeScheduler {
	advanceBy(delayMs: number): Promise<void>;
	pendingDelays(): number[];
}

export function createManualWorkerRuntimeScheduler(
	initialNow = new Date("2025-01-01T00:00:00.000Z"),
): ManualWorkerRuntimeScheduler {
	let nowMs = initialNow.getTime();
	let nextId = 1;
	const scheduled = new Map<number, Scheduled>();
	const asTimer = (id: number) => id as unknown as Timer;
	const fromTimer = (timer: Timer) => timer as unknown as number;

	const schedule = (handler: () => void, delayMs: number): number => {
		const id = nextId++;
		scheduled.set(id, { id, dueAt: nowMs + delayMs, handler });
		return id;
	};
	const clearTimer = (timer: Timer): void => {
		scheduled.delete(fromTimer(timer));
	};

	return {
		setTimeout: (handler, delayMs) => asTimer(schedule(handler, delayMs)),
		clearTimeout: clearTimer,
		sleep: (delayMs) => new Promise((resolve) => schedule(resolve, delayMs)),
		now() {
			return new Date(nowMs);
		},
		pendingDelays() {
			return [...scheduled.values()]
				.map((item) => item.dueAt - nowMs)
				.sort((left, right) => left - right);
		},
		async advanceBy(delayMs) {
			const target = nowMs + delayMs;
			while (true) {
				const next = [...scheduled.values()]
					.filter((item) => item.dueAt <= target)
					.sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
				if (!next) break;
				nowMs = next.dueAt;
				scheduled.delete(next.id);
				next.handler();
				await Promise.resolve();
			}
			nowMs = target;
		},
	};
}

export interface WorkerRuntimeHarnessOptions {
	config?: Partial<WorkerRuntimeConfig>;
	/** Optional default used by start() and startLlmTo(). */
	startPayload?: WorkerStartPayload;
	adapters: Pick<WorkerRuntimeAdapters, "piFactory" | "gitOps"> &
		Partial<
			Pick<
				WorkerRuntimeAdapters,
				| "sessionSnapshots"
				| "resultImageTools"
				| "resolveWorkerProcess"
				| "stderr"
				| "extensionEvents"
			>
		>;
}

export type WorkerRuntimeObservation =
	| { kind: "ipc"; type: WorkerToServerMessage["type"] }
	| { kind: "extension"; event: string };

export function createWorkerRuntimeHarness(options: WorkerRuntimeHarnessOptions) {
	let messageHandler: ((message: ServerToWorkerMessage) => void) | undefined;
	let errorHandler: ((error: Error) => void) | undefined;
	let connectHandler: (() => void) | undefined;
	const outgoing: WorkerToServerMessage[] = [];
	const waiters = new Set<MessageWaiter>();
	const messagesOfType = <T extends WorkerMessageType>(type: T): WorkerMessageByType<T>[] =>
		outgoing.filter((message) => message.type === type) as WorkerMessageByType<T>[];
	const notifyWaiters = (): void => {
		for (const waiter of waiters) {
			const matches = messagesOfType(waiter.type);
			const message = matches[waiter.count - 1];
			if (!message) continue;
			waiters.delete(waiter);
			waiter.resolve(message);
		}
	};
	const observations: WorkerRuntimeObservation[] = [];
	const exitCodes: number[] = [];
	let transportStartCount = 0;
	let transportStopCount = 0;
	let nextMessageId = 1;
	let latestStart: WorkerStartPayload | undefined;
	const instanceId = options.config?.instanceId ?? "proc_test";
	const workerId = options.config?.workerId ?? "worker_test";
	const deliver = <T extends ServerMessageType>(
		type: T,
		payload: ServerMessagePayloadByType[T],
	): void => {
		if (type === "worker.start") latestStart = payload as WorkerStartPayload;
		messageHandler?.(
			createIpcMessage({
				type,
				payload,
				messageId: `harness_${nextMessageId++}`,
				instanceId,
				workerId,
			} as never) as ServerToWorkerMessage,
		);
	};
	const scheduler = createManualWorkerRuntimeScheduler();
	const transport: WorkerRuntimeAdapters["transport"] = {
		send(message) {
			outgoing.push(message);
			observations.push({ kind: "ipc", type: message.type });
			notifyWaiters();
		},
		onMessage(handler) {
			messageHandler = handler;
		},
		onError(handler) {
			errorHandler = handler;
		},
		onConnect(handler) {
			connectHandler = handler;
		},
		start() {
			transportStartCount++;
		},
		stop() {
			transportStopCount++;
		},
	};
	const delegatedExtensionEvents = options.adapters.extensionEvents ?? createEventBus();
	const extensionEvents: NonNullable<WorkerRuntimeAdapters["extensionEvents"]> = {
		emit(event, payload) {
			observations.push({ kind: "extension", event });
			delegatedExtensionEvents.emit(event, payload);
		},
		on(event, handler) {
			delegatedExtensionEvents.on(event, handler);
		},
		off(event, handler) {
			delegatedExtensionEvents.off(event, handler);
		},
	};
	const runtime = createWorkerRuntime({
		config: {
			instanceId,
			workerId,
			heartbeatIntervalMs: options.config?.heartbeatIntervalMs,
			turnMaxDurationMs: options.config?.turnMaxDurationMs,
			turnInactivityTimeoutMs: options.config?.turnInactivityTimeoutMs,
			turnAbortGracePeriodMs: options.config?.turnAbortGracePeriodMs,
		},
		adapters: {
			transport,
			scheduler,
			resultImageTools: options.adapters.resultImageTools ?? { create: () => null },
			piFactory: options.adapters.piFactory,
			gitOps: options.adapters.gitOps,
			resolveWorkerProcess: options.adapters.resolveWorkerProcess,
			stderr: options.adapters.stderr,
			extensionEvents,
			sessionSnapshots:
				options.adapters.sessionSnapshots ??
				({
					async uploadSnapshot() {
						return { kind: "uploaded", bytes: 0 } as const;
					},
				} satisfies WorkerRuntimeAdapters["sessionSnapshots"]),
			exit(code) {
				exitCodes.push(code);
			},
		},
	});

	return {
		scheduler,
		outgoing,
		observations,
		exitCodes,
		get transportStartCount() {
			return transportStartCount;
		},
		get transportStopCount() {
			return transportStopCount;
		},
		deliver,
		async connect() {
			await runtime.start();
		},
		async start(payload = options.startPayload) {
			if (!payload) throw new Error("WorkerRuntimeHarness.start requires a start payload");
			await this.connect();
			deliver("worker.start", payload);
			await this.flush();
		},
		async stop(reason: string) {
			await runtime.stop(reason);
		},
		async acceptStart(acceptance: { startRecordId?: string; turnRecordId?: string } = {}) {
			if (!latestStart) throw new Error("Cannot accept a turn before worker.start");
			deliver("worker.turn_start_accepted", {
				startRecordId: acceptance.startRecordId ?? latestStart.turnStart.id,
				turnRecordId: acceptance.turnRecordId ?? latestStart.turnStart.proposedTurnRecordId,
			});
			await this.flush();
		},
		async startLlmTo<T extends WorkerMessageType>(
			type: T,
			payload = options.startPayload,
		): Promise<WorkerMessageByType<T>> {
			if (!payload) throw new Error("WorkerRuntimeHarness.startLlmTo requires a start payload");
			if (payload.bootstrap.kind !== "llm") {
				throw new Error("WorkerRuntimeHarness.startLlmTo requires an LLM start payload");
			}
			await this.start(payload);
			await this.waitForMessage("worker.ready");
			await this.acceptStart();
			return this.waitForMessage(type);
		},
		reconnect() {
			connectHandler?.();
		},
		failTransport(error: Error) {
			errorHandler?.(error);
		},
		async waitForMessage<T extends WorkerMessageType>(
			type: T,
			count = 1,
		): Promise<WorkerMessageByType<T>> {
			const matches = messagesOfType(type);
			if (matches.length >= count) return matches[count - 1] as (typeof matches)[number];
			return new Promise<(typeof matches)[number]>((resolve) =>
				waiters.add({
					type,
					count,
					resolve: (message) => resolve(message as (typeof matches)[number]),
				}),
			);
		},
		async flush() {
			for (let index = 0; index < 100; index++)
				await new Promise<void>((resolve) => setImmediate(resolve));
		},
	};
}

export type WorkerRuntimeHarness = ReturnType<typeof createWorkerRuntimeHarness>;
