import type { FutureExecutionLifecycle } from "./future-execution/index.js";

export interface FutureExecutionSchedulerOptions {
	pollIntervalMs?: number;
	now?: () => Date;
}

export function startFutureExecutionScheduler(
	lifecycle: Pick<FutureExecutionLifecycle, "reconcileMissedScheduleOccurrences" | "runDueWork">,
	options: FutureExecutionSchedulerOptions = {},
) {
	const pollIntervalMs = options.pollIntervalMs ?? 1_000;
	const nowFn = options.now ?? (() => new Date());
	let timer: ReturnType<typeof setInterval> | null = null;
	let tickInProgress = false;

	async function tick(): Promise<void> {
		if (tickInProgress) {
			return;
		}
		tickInProgress = true;
		try {
			await lifecycle.runDueWork(nowFn().toISOString());
		} finally {
			tickInProgress = false;
		}
	}

	return {
		async start(): Promise<void> {
			await lifecycle.reconcileMissedScheduleOccurrences(nowFn().toISOString());
			await tick();
			if (timer) {
				return;
			}
			timer = setInterval(() => {
				void tick();
			}, pollIntervalMs);
		},
		stop(): void {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
