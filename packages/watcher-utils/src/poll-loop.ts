import { parseDurationMs } from "./duration-parse.js";

/** Reserve the next poll time for a caller-owned key, before starting its work. */
/** @internal */
export function createPollSchedule(now: () => number = () => Date.now()) {
	const dueAt = new Map<string, number>();
	return (key: string, interval = "30s", timestamp = now()): boolean => {
		if ((dueAt.get(key) ?? 0) > timestamp) return false;
		dueAt.set(key, timestamp + parseDurationMs(interval, 30_000));
		return true;
	};
}

/** @public */
export interface PollResult {
	/** @public */
	created: string[];
	/** @internal */
	aborted: string[];
	/** @internal */
	labelExchanged: string[];
	/** @public */
	skipped: string[];
	/** @public */
	errors: string[];
}

/** @public */
export function emptyPollResult(): PollResult {
	return {
		created: [],
		aborted: [],
		labelExchanged: [],
		skipped: [],
		errors: [],
	};
}

/** @internal */
export interface PollResultWithErrors {
	/** @internal */
	readonly errors: readonly string[];
}

/** @internal */
export interface PollLoop<T extends PollResultWithErrors = PollResult> {
	/** @internal */
	poll(): Promise<T>;
	/** @internal */
	start(): void;
	/** @internal */
	stop(): void;
}

/**
 * Create a non-overlapping polling loop. `pollOnce` is the actual work;
 * concurrent calls to `poll()` coalesce into the in-flight promise.
 */
/** @internal */
export function createPollLoop<T extends PollResultWithErrors>(opts: {
	/** @internal */
	pollOnce: () => Promise<T>;
	/** @internal */
	isEnabled: () => boolean;
	/** @internal */
	pollInterval: () => string;
	/** @internal */
	defaultIntervalMs?: number;
	/** @internal */
	onScheduledResult: (result: T, durationMs: number) => void;
	/** @internal */
	onScheduledError: (error: unknown, durationMs: number) => void;
}): PollLoop<T> {
	let timer: ReturnType<typeof setInterval> | null = null;
	let pollInFlight: Promise<T> | null = null;
	const defaultMs = opts.defaultIntervalMs ?? 60_000;

	async function poll(): Promise<T> {
		if (pollInFlight) {
			return pollInFlight;
		}
		const running = (async () => {
			try {
				return await opts.pollOnce();
			} finally {
				pollInFlight = null;
			}
		})();
		pollInFlight = running;
		return running;
	}

	function pollScheduled(): void {
		const startedAt = Date.now();
		void poll().then(
			(result) => opts.onScheduledResult(result, Date.now() - startedAt),
			(error: unknown) => opts.onScheduledError(error, Date.now() - startedAt),
		);
	}

	return {
		poll,
		start() {
			if (timer) {
				return;
			}
			if (!opts.isEnabled()) {
				return;
			}
			const ms = parseDurationMs(opts.pollInterval(), defaultMs);
			timer = setInterval(pollScheduled, ms);
			pollScheduled();
		},
		stop() {
			if (!timer) {
				return;
			}
			clearInterval(timer);
			timer = null;
		},
	};
}
