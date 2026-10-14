import type {
	AutomaticStartupRecoverySummary,
	ProcessEvent,
	StartupRetryState,
	TurnStartRecord,
} from "@leitwerk-dev/domain";

/** @internal */
export const MAX_STARTUP_STARTS = 3;

/** Read retained history only for starts written before retry metadata existed. @internal */
export function startupRetryState(
	start: TurnStartRecord,
	starts: readonly TurnStartRecord[],
	events: readonly ProcessEvent[] = [],
): StartupRetryState {
	if (start.state.automaticRetry) return start.state.automaticRetry;
	const byId = new Map(starts.map((entry) => [entry.id, entry]));
	const predecessors = new Map(
		events
			.filter((event) => event.eventType === "startup_retry_scheduled")
			.map((event) => [String(event.data.startRecordId), event]),
	);
	let current = start;
	let count = 1;
	const seen = new Set([start.id]);
	while (current.startKind === "startup_retry") {
		const event = predecessors.get(current.id);
		const actor = event?.data.actor as { kind?: string } | undefined;
		if (event?.data.retrySource === "manual" || (actor && actor.kind !== "system")) break;
		const previous = byId.get(String(event?.data.previousStartRecordId));
		if (!previous || seen.has(previous.id) || previous.turnId !== start.turnId) {
			// Missing legacy history must not grant a new allowance after an upgrade.
			count = Math.max(count, MAX_STARTUP_STARTS);
			break;
		}
		seen.add(previous.id);
		count += 1;
		current = previous;
		if (current.state.automaticRetry) {
			return {
				...current.state.automaticRetry,
				starts: current.state.automaticRetry.starts + count - 1,
				nextRetryAt: null,
			};
		}
	}
	return { episodeStartRecordId: current.id, starts: count, nextRetryAt: null };
}

/** Configuration, unknown errors and OOMs require attention rather than blind retries. @internal */
export function automaticStartupRecovery(
	start: TurnStartRecord,
	retry: StartupRetryState,
	now = Date.now(),
	modelRestored = false,
): AutomaticStartupRecoverySummary {
	const base = { starts: retry.starts, maxStarts: MAX_STARTUP_STARTS, nextRetryAt: null };
	if (start.state.kind !== "preparation_failed" && start.state.kind !== "bootstrap_failed")
		return {
			...base,
			status: "blocked",
			reason: "This start is no longer eligible for automatic recovery.",
		};
	const code = start.state.code;
	const modelFailure = code === "model_unavailable" || code === "model_stale";
	const transient =
		start.state.kind === "bootstrap_failed" &&
		[
			"startup_timeout",
			"spawn_error",
			"worker_spawn_failed",
			"worker_adoption_failed",
			"process_exited",
		].includes(code);
	if (!modelFailure && !transient)
		return {
			...base,
			status: "blocked",
			reason: "Automatic retry stopped. Correct the failure and retry manually.",
		};
	if (retry.starts >= MAX_STARTUP_STARTS)
		return {
			...base,
			status: "exhausted",
			reason: "Automatic startup retries exhausted. Retry manually after correcting the failure.",
		};
	if (modelFailure)
		return {
			...base,
			status: modelRestored ? "ready" : "waiting_for_model",
			reason: modelRestored
				? "Model availability restored."
				: "Waiting for model availability to be restored.",
		};
	const failureAt = Date.parse(start.updatedAt);
	if (!Number.isFinite(failureAt))
		return {
			...base,
			status: "blocked",
			reason: "Startup failure timing is unavailable. Retry manually.",
		};
	const nextRetryAt =
		retry.nextRetryAt ?? new Date(failureAt + 30_000 * 2 ** (retry.starts - 1)).toISOString();
	return {
		...base,
		nextRetryAt,
		status: Date.parse(nextRetryAt) > now ? "waiting" : "ready",
		reason: "A transient worker startup failure is eligible for automatic recovery.",
	};
}
