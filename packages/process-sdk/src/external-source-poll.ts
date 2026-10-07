import type {
	ExternalObservationInput,
	ExternalSourceArmingLike,
	ExternalSourceServiceLike,
} from "./core-capabilities.js";

/** @internal */
type Arming = Pick<ExternalSourceArmingLike, "id" | "instanceId" | "generation">;

/** Report one poll's effects without choosing events, scheduling, or subscription policy. */
/** @internal */
export function createExternalSourcePollReporter(
	sources: ExternalSourceServiceLike,
	result: {
		/** @internal */
		created: string[];
		/** @internal */
		errors: string[];
	},
	options: {
		/** @internal */
		forwardGeneration?: boolean;
	} = {},
) {
	return {
		/** @internal */
		async poll(kind: string, read: (armed: ExternalSourceArmingLike) => Promise<void>) {
			for (const armed of sources.listArmed(kind)) {
				try {
					await read(armed);
				} catch (error) {
					result.errors.push(
						`${armed.id}:${error instanceof Error ? error.message : "poll_failed"}`,
					);
				}
			}
		},
		/** @internal */
		async fire(armed: Arming, event: Record<string, unknown>, mergeKey: string): Promise<boolean> {
			const fired = await sources.fire({
				instanceId: armed.instanceId,
				armingId: armed.id,
				...(options.forwardGeneration && armed.generation ? { generation: armed.generation } : {}),
				event,
				mergeKey,
			});
			if (fired.ok) result.created.push(armed.id);
			else result.errors.push(`${armed.id}:fire_failed`);
			return fired.ok;
		},
		/** @internal */
		observe(armed: Arming, input: Pick<ExternalObservationInput, "observation" | "refreshError">) {
			if (sources.observe && armed.generation)
				return sources.observe({
					instanceId: armed.instanceId,
					armingId: armed.id,
					generation: armed.generation,
					...input,
				});
		},
	};
}
