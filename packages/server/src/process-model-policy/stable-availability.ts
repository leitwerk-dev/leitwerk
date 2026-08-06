import type { ModelStatusCacheSnapshot } from "../model-providers/model-status-cache.js";

export type StableAvailabilityEvaluation<T> =
	| { ok: true; availability: ModelStatusCacheSnapshot; value: T }
	| { ok: false; availability: ModelStatusCacheSnapshot };

/** Evaluates against one availability revision, retrying once when that revision changes. */
export async function evaluateAtStableAvailabilityRevision<T>(input: {
	availability: ModelStatusCacheSnapshot;
	getModelAvailabilitySnapshot: () => ModelStatusCacheSnapshot;
	evaluate: (availability: ModelStatusCacheSnapshot) => T | Promise<T>;
	beforeRetry?: () => void | Promise<void>;
}): Promise<StableAvailabilityEvaluation<T>> {
	let availability = input.availability;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const value = await input.evaluate(availability);
		const current = input.getModelAvailabilitySnapshot();
		if (current.revision === availability.revision) {
			return { ok: true, availability, value };
		}
		availability = current;
		if (attempt === 0) await input.beforeRetry?.();
	}
	return { ok: false, availability };
}
