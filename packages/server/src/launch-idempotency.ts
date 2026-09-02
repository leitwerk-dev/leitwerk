import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";

/**
 * Identifies one provider event at launch admission. A failed attempt may archive
 * this key so a later poll can create a new launch run.
 */
export function watcherAdmissionKey(stableEventKey: string): string {
	const key = stableEventKey.trim();
	if (!key) throw new Error("Watcher admission key must not be empty");
	return key;
}

/**
 * Identifies process creation across watcher retries. Unlike launch admission,
 * this key remains authoritative after a process commit.
 */
export function withWatcherHandoffDedupKey(
	launchPlan: ProcessLaunchPlan,
	stableEventKey: string,
): ProcessLaunchPlan {
	return { ...launchPlan, handoffDedupKey: watcherAdmissionKey(stableEventKey) };
}

/** Identifies one durable occurrence of a scheduled launch. */
export function scheduledLaunchOccurrenceKey(input: {
	futureExecutionId: string;
	nextRunAt: string;
}): string {
	return `scheduled:${input.futureExecutionId}:${input.nextRunAt}`;
}
