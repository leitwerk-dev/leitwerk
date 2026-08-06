import { parseDurationMs } from "./duration-parse.js";

export interface PollResult {
	created: string[];
	aborted: string[];
	labelExchanged: string[];
	skipped: string[];
	errors: string[];
}

export function emptyPollResult(): PollResult {
	return {
		created: [],
		aborted: [],
		labelExchanged: [],
		skipped: [],
		errors: [],
	};
}

export interface PollLoop<T extends PollResult = PollResult> {
	poll(): Promise<T>;
	start(): void;
	stop(): void;
}

/**
 * Create a non-overlapping polling loop. `pollOnce` is the actual work;
 * concurrent calls to `poll()` coalesce into the in-flight promise.
 */
export function createPollLoop<T extends PollResult>(opts: {
	pollOnce: () => Promise<T>;
	isEnabled: () => boolean;
	pollInterval: () => string;
	defaultIntervalMs?: number;
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

	function pollAndIgnoreUnhandledRejection(): void {
		void poll().catch(() => undefined);
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
			timer = setInterval(pollAndIgnoreUnhandledRejection, ms);
			pollAndIgnoreUnhandledRejection();
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
