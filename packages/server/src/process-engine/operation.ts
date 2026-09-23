/** @internal */
export interface OperationInputBase {
	/** @internal */
	instanceId: string;
}

/** @internal */
export interface OperationMessages {
	/** @internal */
	dispatchErrorMessage?: string;
	/** @internal */
	reconcileErrorMessage?: string;
}

/** @internal */
type DecideFunction<TInput extends OperationInputBase, TData> = {
	/** @internal */
	bivarianceHack(
		ctx: import("./types.js").DecideContext,
		input: TInput,
	):
		| Promise<import("./decision.js").DecideResult<TData>>
		| import("./decision.js").DecideResult<TData>;
}["bivarianceHack"];

/** @internal */
type MessageResolver<TInput extends OperationInputBase> = {
	/** @internal */
	bivarianceHack(input: TInput): OperationMessages;
}["bivarianceHack"];

/** @internal */
type BestEffortFailureReportingResolver<TInput extends OperationInputBase> = {
	/** @internal */
	bivarianceHack(input: TInput): boolean;
}["bivarianceHack"];

/** @internal */
type AfterRecordFunction<TInput extends OperationInputBase, TData> = {
	/** @internal */
	bivarianceHack(input: TInput, data: TData): void;
}["bivarianceHack"];

/** @internal */
export interface OperationSpec<TKind extends string, TInput extends OperationInputBase, TData> {
	/** @internal */
	kind: TKind;
	/** @internal */
	label?: string;
	/** Reject this operation while another subsystem has reserved new-turn admission. @internal */
	admission?: "new_turn";

	/**
	 * Operation decisions are pure with respect to process-owned durable state and
	 * the outside world: they may read repositories and prepare writes/reactions,
	 * but they must not commit state, broadcast, dispatch inputs, control workers,
	 * or emit extension events.
	 */
	/** @internal */
	decide: DecideFunction<TInput, TData>;

	/** Runs after durable recording and lock release, even if reaction derivation fails. @internal */
	afterRecord?: AfterRecordFunction<TInput, TData>;
	/** @internal */
	messages?: OperationMessages | MessageResolver<TInput>;
	/** @internal */
	reportBestEffortFailures?: boolean | BestEffortFailureReportingResolver<TInput>;
}

export function defineOperation<
	const TKind extends string,
	TInput extends OperationInputBase,
	TData,
>(spec: OperationSpec<TKind, TInput, TData>): OperationSpec<TKind, TInput, TData> {
	return spec;
}

/** @internal */
export type OperationInput<TOp> =
	TOp extends OperationSpec<string, infer TInput, unknown> ? TInput : never;

/** @internal */
export type OperationData<TOp> =
	TOp extends OperationSpec<string, OperationInputBase, infer TData> ? TData : never;
