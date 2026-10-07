import type { CapabilityToken } from "./capabilities.js";
import type { ProcessSnapshotContext } from "./extension-api.js";

/** A terminal decision returned from a turn's server-side waiting condition. @public */
export interface TurnWaitCompletion {
	/** @internal */
	readonly kind: "complete";
}

/** Server context for a repeatable condition. External operations must be read-only. @public */
export interface TurnWaitContext<TParams = unknown, TState = unknown>
	extends ProcessSnapshotContext<TParams, TState> {
	/** Cancelled on timeout or server shutdown. @public */
	readonly signal: AbortSignal;
	/** Resolve an extension-owned server adapter. Never perform external writes here. @public */
	require<T>(token: CapabilityToken<T>): T | T[];
	/** Stage process state with this check; stale and failed checks discard it. @public */
	setState(state: TState): void;
	/** Finish the process without allocating a worker. Return this decision. @public */
	complete(): TurnWaitCompletion;
}

/** False keeps this turn waiting; true permits execution; complete ends the process. @public */
export type TurnWaitPredicate<TParams = unknown, TState = unknown> = (
	process: TurnWaitContext<TParams, TState>,
) => boolean | TurnWaitCompletion | Promise<boolean | TurnWaitCompletion>;

/** A temporary observation failure. Other predicate errors require an explicit retry. @public */
export class RetryableWaitError extends Error {
	/** The message must be safe to show to an operator. @public */
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RetryableWaitError";
	}
}
