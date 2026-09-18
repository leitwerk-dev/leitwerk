import { createPollLoop, type PollResult, type PollResultWithErrors } from "./poll-loop.js";

/** @internal */
export interface PollingLogger {
	/** @internal */
	warn(payload: Record<string, unknown>, message?: string): void;
	/** @internal */
	error(payload: Record<string, unknown>, message?: string): void;
}

/** @internal */
export interface PollingRegistration<T extends PollResultWithErrors> {
	/** @internal */
	id: string;
	/** @internal */
	pollOnce(): Promise<T>;
	/** @internal */
	isEnabled(): boolean;
	/** @internal */
	pollInterval(): string;
	/** @internal */
	defaultIntervalMs?: number;
}

/** @internal */
export interface RegisteredPoller<T extends PollResultWithErrors = PollResult> {
	/** @internal */
	poll(): Promise<T>;
}

/** @internal */
export interface PollingCoordinator {
	/** @internal */
	create<T extends PollResultWithErrors>(registration: PollingRegistration<T>): RegisteredPoller<T>;
	/** @internal */
	start(): void;
	/** @internal */
	stop(): void;
}

/** @internal */
export function createPollingCoordinator(logger: PollingLogger): PollingCoordinator {
	const loops = new Map<string, ReturnType<typeof createPollLoop>>();
	let sealed = false;

	return {
		create<T extends PollResultWithErrors>(
			registration: PollingRegistration<T>,
		): RegisteredPoller<T> {
			const id = registration.id.trim();
			if (!id) throw new Error("Polling registration id must not be empty");
			if (sealed) throw new Error(`Cannot register poller '${id}' after polling has started`);
			if (loops.has(id)) throw new Error(`Duplicate poller '${id}'`);

			const loop = createPollLoop({
				pollOnce: registration.pollOnce,
				isEnabled: registration.isEnabled,
				pollInterval: registration.pollInterval,
				defaultIntervalMs: registration.defaultIntervalMs,
				onScheduledResult(result, durationMs) {
					if (result.errors.length === 0) return;
					logger.warn({ pollerId: id, durationMs, result }, "Poll completed with errors");
				},
				onScheduledError(error, durationMs) {
					logger.error({ pollerId: id, durationMs, err: error }, "Poll failed");
				},
			});
			loops.set(id, loop);
			return { poll: loop.poll };
		},
		start() {
			sealed = true;
			for (const loop of loops.values()) loop.start();
		},
		stop() {
			for (const loop of loops.values()) loop.stop();
		},
	};
}
