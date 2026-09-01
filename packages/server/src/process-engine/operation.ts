export interface OperationInputBase {
	instanceId: string;
}

export interface OperationMessages {
	dispatchErrorMessage?: string;
	reconcileErrorMessage?: string;
}

type DecideFunction<TInput extends OperationInputBase, TData> = {
	bivarianceHack(
		ctx: import("./types.js").DecideContext,
		input: TInput,
	):
		| Promise<import("./decision.js").DecideResult<TData>>
		| import("./decision.js").DecideResult<TData>;
}["bivarianceHack"];

type MessageResolver<TInput extends OperationInputBase> = {
	bivarianceHack(input: TInput): OperationMessages;
}["bivarianceHack"];

type BestEffortFailureReportingResolver<TInput extends OperationInputBase> = {
	bivarianceHack(input: TInput): boolean;
}["bivarianceHack"];

type AfterRecordFunction<TInput extends OperationInputBase, TData> = {
	bivarianceHack(input: TInput, data: TData): void;
}["bivarianceHack"];

export interface OperationSpec<TKind extends string, TInput extends OperationInputBase, TData> {
	kind: TKind;
	label?: string;

	/**
	 * Operation decisions are pure with respect to process-owned durable state and
	 * the outside world: they may read repositories and prepare writes/reactions,
	 * but they must not commit state, broadcast, dispatch inputs, control workers,
	 * or emit extension events.
	 */
	decide: DecideFunction<TInput, TData>;

	/** Runs after the transaction and process lock complete, before reactions are dispatched. */
	afterRecord?: AfterRecordFunction<TInput, TData>;
	messages?: OperationMessages | MessageResolver<TInput>;
	reportBestEffortFailures?: boolean | BestEffortFailureReportingResolver<TInput>;
}

export function defineOperation<
	const TKind extends string,
	TInput extends OperationInputBase,
	TData,
>(spec: OperationSpec<TKind, TInput, TData>): OperationSpec<TKind, TInput, TData> {
	return spec;
}

export type OperationInput<TOp> =
	TOp extends OperationSpec<string, infer TInput, unknown> ? TInput : never;

export type OperationData<TOp> =
	TOp extends OperationSpec<string, OperationInputBase, infer TData> ? TData : never;
