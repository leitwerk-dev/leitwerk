/** FIFO admission without holding a process operation open while capacity is full. */
export function createWorkerCapacityQueue<T>(deps: {
	limit: number;
	activeCount(): number;
	isCurrent(instanceId: string, startId: string): boolean;
	start(instanceId: string): Promise<T>;
	onQueued(instanceId: string, startId: string): void;
	onFailure(instanceId: string, error: unknown): void;
}) {
	const waiting = new Map<string, string>();
	const starting = new Map<string, Promise<T>>();
	let scheduled: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const hasCapacity = () => deps.activeCount() + starting.size < deps.limit;

	function wake(): void {
		if (stopped || scheduled || !waiting.size) return;
		scheduled = setTimeout(() => {
			scheduled = undefined;
			for (const [instanceId, startId] of waiting) {
				if (!deps.isCurrent(instanceId, startId)) {
					waiting.delete(instanceId);
					continue;
				}
				if (!hasCapacity() || starting.has(instanceId)) break;
				waiting.delete(instanceId);
				void launch(instanceId).catch((error) => deps.onFailure(instanceId, error));
			}
		}, 0);
		scheduled.unref();
	}

	function launch(instanceId: string): Promise<T> {
		// Reserve before yielding, including while volume/runtime allocation is pending.
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		starting.set(instanceId, promise);
		try {
			deps.start(instanceId).then(resolve, reject);
		} catch (error) {
			reject(error);
		}
		void promise
			.finally(() => {
				starting.delete(instanceId);
				wake();
			})
			.catch(() => {});
		return promise;
	}

	return {
		request(instanceId: string, startId: string): Promise<T | undefined> {
			if (stopped) return Promise.reject(new Error("Worker supervisor is shutting down"));
			const pending = starting.get(instanceId);
			if (pending) return pending;
			if (!waiting.size && hasCapacity()) return launch(instanceId);
			if (waiting.get(instanceId) !== startId) {
				waiting.set(instanceId, startId);
				deps.onQueued(instanceId, startId);
			}
			wake();
			return Promise.resolve(undefined);
		},
		async cancel(instanceId: string): Promise<void> {
			waiting.delete(instanceId);
			wake();
			await starting.get(instanceId)?.catch(() => {});
		},
		wake,
		async stop(): Promise<void> {
			stopped = true;
			waiting.clear();
			clearTimeout(scheduled);
			scheduled = undefined;
			await Promise.allSettled(starting.values());
		},
	};
}
