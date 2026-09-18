/** @internal */
export interface ProcessOperationCoordinator {
	/** @internal */
	runExclusive<T>(instanceId: string, operation: () => Promise<T> | T): Promise<T>;
}

/** @internal */
export function createProcessOperationCoordinator(): ProcessOperationCoordinator {
	const tails = new Map<string, Promise<void>>();

	return {
		async runExclusive<T>(instanceId: string, operation: () => Promise<T> | T): Promise<T> {
			const previous = tails.get(instanceId) ?? Promise.resolve();
			const { promise: current, resolve: release } = Promise.withResolvers<void>();
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
