import type { CapabilityToken } from "./capabilities.js";
import type {
	ProcessLaunchConfig,
	ProcessLaunchProjectConfig,
	ProcessSnapshotContext,
} from "./extension-api.js";

/** Initial repository bindings resolved before the first execution. @public */
export type InitialProcessBinding<TParams = unknown> = Pick<
	ProcessLaunchConfig<TParams>,
	"params" | "metadata" | "settingsContext"
> & {
	/** Complete, nonempty repository set. @public */
	projects: readonly ProcessLaunchProjectConfig[];
};

/** A server-owned readiness decision, with no worker attempt. @public */
export type TurnWaitDecision<TParams = unknown> =
	| TurnWaitCompletion
	| TurnWaitNotice
	| TurnWaitBinding<TParams>;

/** A readiness condition or source cancellation with operator guidance. @public */
export interface TurnWaitNotice {
	/** @internal */
	readonly kind: "waiting" | "abort";
	/** Safe operator guidance. @public */
	readonly message: string;
}

/** Initial bindings staged by a successful readiness check. @public */
export interface TurnWaitBinding<TParams = unknown> {
	/** @internal */
	readonly kind: "bind";
	/** @internal */
	readonly binding: InitialProcessBinding<TParams>;
}

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
	/** Wait at the normal polling interval with safe operator guidance. Return this decision. @public */
	waiting(message: string): TurnWaitDecision<TParams>;
	/** Abort without a worker when the source is cancelled. Return this decision. @public */
	abort(message: string): TurnWaitDecision<TParams>;
	/** Bind initial params and projects atomically, then check again before starting a worker. Only available before any project or execution exists. @public */
	bindInitialProjects(binding: InitialProcessBinding<TParams>): TurnWaitDecision<TParams>;
	/** Finish the process without allocating a worker. Return this decision. @public */
	complete(): TurnWaitCompletion;
}

/** False keeps this turn waiting; true permits execution; complete ends the process. @public */
export type TurnWaitPredicate<TParams = unknown, TState = unknown> = (
	process: TurnWaitContext<TParams, TState>,
) => boolean | TurnWaitDecision<TParams> | Promise<boolean | TurnWaitDecision<TParams>>;

/** A temporary observation failure. Other predicate errors require an explicit retry. @public */
export class RetryableWaitError extends Error {
	/** The message must be safe to show to an operator. @public */
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "RetryableWaitError";
	}
}
