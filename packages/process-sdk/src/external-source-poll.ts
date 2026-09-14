import type {
	ExternalObservationInput,
	ExternalSourceArmingLike,
	ExternalSourceServiceLike,
} from "./core-capabilities.js";

type Arming = Pick<ExternalSourceArmingLike, "id" | "instanceId" | "generation">;

/** Report one poll's effects without choosing events, scheduling, or subscription policy. */
export function createExternalSourcePollReporter(
	sources: ExternalSourceServiceLike,
	result: { created: string[]; errors: string[] },
) {
	return {
		async fire(armed: Arming, event: Record<string, unknown>, mergeKey: string): Promise<boolean> {
			const fired = await sources.fire({
				instanceId: armed.instanceId,
				armingId: armed.id,
				event,
				mergeKey,
			});
			if (fired.ok) result.created.push(armed.id);
			else result.errors.push(`${armed.id}:fire_failed`);
			return fired.ok;
		},
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
