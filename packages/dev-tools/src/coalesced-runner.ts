/** Coalesces concurrent requests into at most one follow-up run. */
export function createCoalescedRunner(
	task: () => Promise<void>,
	isStopped: () => boolean,
): { run(): void; isRunning(): boolean } {
	let running = false;
	let queued = false;
	return {
		run() {
			if (running || isStopped()) {
				queued = true;
				return;
			}
			running = true;
			void (async () => {
				try {
					do {
						queued = false;
						await task();
					} while (queued && !isStopped());
				} finally {
					running = false;
				}
			})();
		},
		isRunning: () => running,
	};
}
