import type {
	StopWorkerOptions,
	WorkerExitInfo,
	WorkerRunner,
	WorkerUnit,
	WorkerUnitRef,
} from "@leitwerk-dev/worker-runners/types";

export interface WorkerUnitCleanupLogger {
	info?(bindings: Record<string, unknown>, message: string): void;
	warn?(bindings: Record<string, unknown>, message: string): void;
}

export interface WorkerUnitReclaimerDeps {
	runner: Pick<WorkerRunner, "stop">;
	logger?: WorkerUnitCleanupLogger;
	retry?: {
		initialDelayMs?: number;
		maxDelayMs?: number;
		sleep?: (ms: number) => Promise<void>;
	};
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function descriptorKey(ref: WorkerUnitRef): string {
	return `${ref.namespace ?? ""}/${ref.unitId}`;
}

function logBindings(
	ref: WorkerUnitRef,
	source: string,
	staleResourceBacklogCount: number,
): Record<string, unknown> {
	return {
		instanceId: ref.instanceId,
		workerId: ref.workerId,
		unitId: ref.unitId,
		...(ref.namespace ? { namespace: ref.namespace } : {}),
		source,
		staleResourceBacklogCount,
	};
}

/** Reclaims terminal worker units without making cleanup a server availability dependency. */
export function createWorkerUnitReclaimer(deps: WorkerUnitReclaimerDeps) {
	const backlog = new Map<string, WorkerUnitRef>();
	const sleep = deps.retry?.sleep ?? defaultSleep;
	const initialDelayMs = Math.max(1, deps.retry?.initialDelayMs ?? 250);
	const maxDelayMs = Math.max(initialDelayMs, deps.retry?.maxDelayMs ?? 30_000);
	let retryLoop: Promise<void> | null = null;

	async function attempt(ref: WorkerUnitRef, source: string): Promise<boolean> {
		const key = descriptorKey(ref);
		deps.logger?.info?.(logBindings(ref, source, backlog.size), "Reclaiming terminal worker unit");
		try {
			const options: StopWorkerOptions = { graceMs: 0 };
			await deps.runner.stop(ref, options);
			backlog.delete(key);
			deps.logger?.info?.(logBindings(ref, source, backlog.size), "Reclaimed terminal worker unit");
			return true;
		} catch (error) {
			backlog.set(key, ref);
			deps.logger?.warn?.(
				{ ...logBindings(ref, source, backlog.size), err: error },
				"Terminal worker unit cleanup failed; queued for retry",
			);
			return false;
		}
	}

	function ensureRetryLoop(): void {
		if (retryLoop || backlog.size === 0) return;
		retryLoop = (async () => {
			let delayMs = initialDelayMs;
			while (backlog.size > 0) {
				await sleep(delayMs);
				for (const ref of [...backlog.values()]) {
					await attempt(ref, "background_retry");
				}
				delayMs = Math.min(maxDelayMs, delayMs * 2);
			}
		})().finally(() => {
			retryLoop = null;
			ensureRetryLoop();
		});
	}

	async function reclaim(ref: WorkerUnitRef, source: string): Promise<void> {
		if (!(await attempt(ref, source))) ensureRetryLoop();
	}

	return {
		reclaim,
		observeExit(unit: WorkerUnit, listener: (info: WorkerExitInfo) => void): void {
			unit.onExit((info) => {
				listener(info);
				void reclaim(unit, "natural_exit");
			});
		},
		staleResourceBacklogCount(): number {
			return backlog.size;
		},
	};
}

export type WorkerUnitReclaimer = ReturnType<typeof createWorkerUnitReclaimer>;
