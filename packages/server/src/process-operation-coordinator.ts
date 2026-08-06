export interface ProcessOperationCoordinator {
	runExclusive<T>(instanceId: string, operation: () => Promise<T> | T): Promise<T>;
}

export function createProcessOperationCoordinator(): ProcessOperationCoordinator {
	const tails = new Map<string, Promise<void>>();

	return {
		async runExclusive<T>(instanceId: string, operation: () => Promise<T> | T): Promise<T> {
			const previous = tails.get(instanceId) ?? Promise.resolve();
			let release!: () => void;
			const current = new Promise<void>((resolve) => {
				release = resolve;
			});
			tails.set(instanceId, current);

			await previous;
			try {
				return await operation();
			} finally {
				release();
				if (tails.get(instanceId) === current) tails.delete(instanceId);
			}
		},
	};
}
