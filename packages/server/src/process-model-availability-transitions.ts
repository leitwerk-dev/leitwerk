import type { ModelStatusCacheSnapshot } from "./model-providers/model-status-cache.js";

/** Applies every model-status change to future rows and only restorations to process recovery. */
export async function applyProcessModelAvailabilityTransitions(input: {
	snapshot: ModelStatusCacheSnapshot;
	reconcileFutureExecutions(profileIds: ReadonlySet<string>): Promise<void>;
	recoverProcesses(profileIds: ReadonlySet<string>): Promise<void>;
}): Promise<void> {
	const changed = new Set(
		input.snapshot.availabilityTransitions.map((transition) => transition.profileId),
	);
	if (changed.size === 0) return;
	await input.reconcileFutureExecutions(changed);

	const restored = new Set(
		input.snapshot.availabilityTransitions
			.filter(
				(transition) =>
					transition.to === "available" &&
					(transition.from === "unavailable" || transition.from === "stale"),
			)
			.map((transition) => transition.profileId),
	);
	if (restored.size > 0) await input.recoverProcesses(restored);
}
