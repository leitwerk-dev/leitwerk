import type {
	ExternalObservationInput,
	ExternalSourceArmingLike,
	ExternalSourceServiceLike,
} from "./core-capabilities.js";

/** @public */
type Arming = Pick<ExternalSourceArmingLike, "id" | "instanceId" | "generation" | "resolved">;

/** Report one poll's effects without choosing events, scheduling, or subscription policy. @public */
export function createExternalSourcePollReporter(
	sources: ExternalSourceServiceLike,
	result: {
		/** @public */
		created: string[];
		/** @public */
		errors: string[];
	},
	options: {
		/** @public */
		forwardGeneration?: boolean;
		/** Live source kinds checked before fire and observe. @public */
		currentKinds?: readonly string[];
	} = {},
): ExternalSourcePollReporter {
	const isCurrent = (kind: string, armed: Arming) =>
		sources.listArmed(kind).some((current) => sameSubscription(armed, current));
	const current = (armed: Arming) =>
		options.currentKinds === undefined ||
		options.currentKinds.some((kind) => isCurrent(kind, armed));
	return {
		isCurrent,
		/** @public */
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
		/** @public */
		async fire(armed: Arming, event: Record<string, unknown>, mergeKey: string): Promise<boolean> {
			if (!current(armed)) return false;
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
		/** @public */
		observe(armed: Arming, input: Pick<ExternalObservationInput, "observation" | "refreshError">) {
			if (current(armed) && sources.observe && armed.generation)
				return sources.observe({
					instanceId: armed.instanceId,
					armingId: armed.id,
					generation: armed.generation,
					...input,
				});
		},
	};
}

/** Effects of one poll, with caller-selected scheduling and event policy. @public */
export interface ExternalSourcePollReporter {
	/** @public */
	poll(kind: string, read: (armed: ExternalSourceArmingLike) => Promise<void>): Promise<void>;
	/** @public */
	fire(armed: Arming, event: Record<string, unknown>, mergeKey: string): Promise<boolean>;
	/** @public */
	observe(
		armed: Arming,
		input: Pick<ExternalObservationInput, "observation" | "refreshError">,
	): ReturnType<NonNullable<ExternalSourceServiceLike["observe"]>> | undefined;
	/** Compare the captured identity, generation and resolved value with a live subscription. @public */
	isCurrent(kind: string, armed: Arming): boolean;
}
/** A captured generation and resolved identity must still be armed after provider I/O. @internal */
function sameSubscription(
	captured: {
		/** @internal */
		id: string;
		/** @internal */
		instanceId: string;
		/** @internal */
		generation?: string;
		/** @internal */
		resolved: unknown;
	},
	current: {
		/** @internal */
		id: string;
		/** @internal */
		instanceId: string;
		/** @internal */
		generation?: string;
		/** @internal */
		resolved: unknown;
	},
): boolean {
	return (
		current.id === captured.id &&
		current.instanceId === captured.instanceId &&
		current.generation === captured.generation &&
		JSON.stringify(current.resolved) === JSON.stringify(captured.resolved)
	);
}
