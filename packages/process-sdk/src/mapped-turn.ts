import type {
	ProcessInstance,
	ProcessProject,
	ProcessTurnTerminalLifecycleStatus,
	TurnId,
} from "@leitwerk-dev/domain";
import type { Codec, ProcessTurnOutcomeEvent } from "./extension-api.js";
import { SafeOutcomePlanningError } from "./extension-api.js";

/** @public */
type MaybePromise<T> = T | Promise<T>;

/** Maximum length of a mapped item key. @internal */
export const MAPPED_ITEM_KEY_MAX_LENGTH = 200;
/** Maximum length of a mapped item label. @internal */
export const MAPPED_ITEM_LABEL_MAX_LENGTH = 200;
/** Maximum number of items frozen by one mapped run. @internal */
export const MAPPED_ITEM_MAX_COUNT = 500;
/** Graph trigger used by a mapped turn's collection route. @internal */
export const MAPPED_COLLECT_TRIGGER = "collect" as const;

/** @internal */
export function mappedCollectTrigger(branchId?: string): string {
	return branchId === undefined ? MAPPED_COLLECT_TRIGGER : `${MAPPED_COLLECT_TRIGGER}:${branchId}`;
}

/** Durable snapshot of process data available to mapped-turn server callbacks. @public */
export interface MappedTurnServerContext<TParams = unknown, TState = unknown> {
	/** @public */
	readonly process: ProcessInstance;
	/** @internal */
	readonly projects: readonly ProcessProject[];
	/** @public */
	readonly params: TParams;
	/** @public */
	readonly state: TState;
}

/** Active item of a mapped LLM turn, as delivered to one worker turn. @public */
export interface MappedTurnItemContext<TItem = unknown> {
	/** Frozen, codec-validated item value. @public */
	readonly item: TItem;
	/** Stable key unique within the run. @public */
	readonly itemKey: string;
	/** Short plain-text label shown to operators. @public */
	readonly itemLabel: string;
	/** Zero-based position in the frozen order. @public */
	readonly itemIndex: number;
	/** Number of frozen items in the run. @public */
	readonly itemCount: number;
}

/** Serialized active item carried by worker payloads and turn records. @internal */
export interface MappedTurnIteration {
	/** @internal */
	readonly runId: string;
	/** @internal */
	readonly itemKey: string;
	/** @internal */
	readonly itemLabel: string;
	/** @internal */
	readonly itemIndex: number;
	/** @internal */
	readonly itemCount: number;
	/** JSON value produced by the item codec. @internal */
	readonly item: unknown;
}

/** @public */
export interface MappedItemInput<TItem = unknown> {
	/** @public */
	readonly item: TItem;
	/** @public */
	readonly index: number;
}

/** @public */
export interface MappedSnapshotInput<TParams = unknown, TState = unknown, TItem = unknown> {
	/** @public */
	readonly params: TParams;
	/** @public */
	readonly state: TState;
	/** @public */
	readonly items: readonly TItem[];
}

/** Context passed to a mapped outcome's `yield` callback. @public */
export interface MappedOutcomeContext<TParams = unknown, TState = unknown, TItem = unknown>
	extends MappedTurnServerContext<TParams, TState>,
		MappedTurnItemContext<TItem> {}

/** @public */
export interface MappedYieldInput<TParams = unknown, TState = unknown, TItem = unknown> {
	/** @public */
	readonly ctx: MappedOutcomeContext<TParams, TState, TItem>;
	/** @public */
	readonly event: ProcessTurnOutcomeEvent;
}

/** @public */
export type MappedItemYield<
	TParams = unknown,
	TState = unknown,
	TItem = unknown,
	TResult = unknown,
> = (input: MappedYieldInput<TParams, TState, TItem>) => MaybePromise<TResult>;

/** @public */
export type MappedCollect<TParams = unknown, TState = unknown, TResult = unknown> = (
	ctx: MappedTurnServerContext<TParams, TState>,
	orderedResults: readonly TResult[],
) => MaybePromise<TState>;

/** Route applied once, after collection. @internal */
export type MappedCollectRouting<TParams = unknown, TState = unknown> =
	| {
			/** @internal */
			kind: "static";
			/** @internal */
			to?: TurnId;
			/** @internal */
			lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
	  }
	| {
			/** @internal */
			kind: "branches";
			/** @internal */
			branches: Readonly<Record<string, TurnId>>;
			/** @internal */
			choose(ctx: MappedTurnServerContext<TParams, TState>): MaybePromise<string>;
	  };

/**
 * Durable sequential iteration of one LLM turn over frozen items. Items run one
 * at a time; each item yields a typed result, and business state and routing
 * change once, when all results are collected.
 * @public
 */
export interface MappedLlmTurnSpec<
	TParams = unknown,
	TState = unknown,
	TItem = unknown,
	TResult = unknown,
> {
	/** Evaluated once when the turn is entered. @public */
	items(ctx: MappedTurnServerContext<TParams, TState>): readonly unknown[] | null | undefined;
	/** @public */
	itemCodec: Codec<TItem>;
	/** @public */
	resultCodec: Codec<TResult>;
	/** @public */
	key(input: MappedItemInput<TItem>): string;
	/** Defaults to the item key. @public */
	label?(input: MappedItemInput<TItem>): string;
	/** Applied in the freezing transaction, before any item starts. @public */
	stateAfterSnapshot?(input: MappedSnapshotInput<TParams, TState, TItem>): TState;
	/** @internal */
	yields: Readonly<Record<string, MappedItemYield<TParams, TState, TItem, TResult>>>;
	/** @internal */
	collect: MappedCollect<TParams, TState, TResult>;
	/** @internal */
	routing: MappedCollectRouting<TParams, TState>;
}

/** @internal */
export interface FrozenMappedItem {
	/** @internal */
	index: number;
	/** @internal */
	key: string;
	/** @internal */
	label: string;
	/** @internal */
	itemJson: string;
}

/** @internal */
export interface MappedFreezeResult<TState = unknown> {
	/** @internal */
	items: FrozenMappedItem[];
	/** State to persist in the freezing transaction, when `stateAfterSnapshot` is declared. @internal */
	state?: TState;
}

/** @internal */
export interface MappedCollectResult<TState = unknown> {
	/** @internal */
	state: TState;
	/** @internal */
	route: {
		/** @internal */
		trigger: string;
		/** @internal */
		nextTurnId?: TurnId;
		/** @internal */
		lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
	};
}

function toJsonValue(value: unknown, context: string): string {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch {
		json = undefined;
	}
	if (json === undefined) {
		throw new SafeOutcomePlanningError("invalid_mapped_value", `${context} is not JSON`);
	}
	return json;
}

function plainText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Evaluates, validates, and serializes the items of a mapped turn. @internal */
export function freezeMappedItems<TParams, TState>(
	turnId: TurnId,
	spec: MappedLlmTurnSpec<TParams, TState>,
	ctx: MappedTurnServerContext<TParams, TState>,
): MappedFreezeResult<TState> {
	const raw = spec.items(ctx) ?? [];
	if (!Array.isArray(raw)) {
		throw new SafeOutcomePlanningError(
			"invalid_mapped_items",
			`Mapped turn '${turnId}' items must be an array`,
		);
	}
	if (raw.length > MAPPED_ITEM_MAX_COUNT) {
		throw new SafeOutcomePlanningError(
			"invalid_mapped_items",
			`Mapped turn '${turnId}' may freeze at most ${MAPPED_ITEM_MAX_COUNT} items`,
		);
	}
	const parsed: unknown[] = [];
	const items: FrozenMappedItem[] = [];
	const keys = new Set<string>();
	for (const [index, value] of raw.entries()) {
		let item: unknown;
		try {
			item = spec.itemCodec.parse(value);
		} catch (error) {
			throw new SafeOutcomePlanningError(
				"invalid_mapped_item",
				`Mapped turn '${turnId}' item ${index} is invalid: ${errorMessage(error)}`,
			);
		}
		const key = spec.key({ item, index });
		if (typeof key !== "string" || key.trim() === "" || key.length > MAPPED_ITEM_KEY_MAX_LENGTH) {
			throw new SafeOutcomePlanningError(
				"invalid_mapped_item_key",
				`Mapped turn '${turnId}' item ${index} needs a non-empty key of at most ${MAPPED_ITEM_KEY_MAX_LENGTH} characters`,
			);
		}
		if (keys.has(key)) {
			throw new SafeOutcomePlanningError(
				"duplicate_mapped_item_key",
				`Mapped turn '${turnId}' repeats item key '${key}'`,
			);
		}
		keys.add(key);
		const rawLabel = spec.label ? spec.label({ item, index }) : key;
		const label = plainText(typeof rawLabel === "string" ? rawLabel : "") || key;
		parsed.push(item);
		items.push({
			index,
			key,
			label: label.slice(0, MAPPED_ITEM_LABEL_MAX_LENGTH),
			itemJson: toJsonValue(
				spec.itemCodec.serialize(item),
				`Mapped turn '${turnId}' item '${key}'`,
			),
		});
	}
	return {
		items,
		...(spec.stateAfterSnapshot
			? {
					state: spec.stateAfterSnapshot({
						params: ctx.params,
						state: ctx.state,
						items: parsed,
					}),
				}
			: {}),
	};
}

/** Maps one item outcome to its serialized, codec-validated result. @internal */
export async function yieldMappedItemResult<TParams, TState>(input: {
	/** @internal */
	turnId: TurnId;
	/** @internal */
	spec: MappedLlmTurnSpec<TParams, TState>;
	/** @internal */
	ctx: MappedTurnServerContext<TParams, TState>;
	/** @internal */
	iteration: MappedTurnIteration;
	/** @internal */
	event: ProcessTurnOutcomeEvent;
}): Promise<string> {
	const yieldResult = input.spec.yields[input.event.outcome];
	if (!yieldResult) {
		throw new SafeOutcomePlanningError(
			"unknown_mapped_outcome",
			`Mapped turn '${input.turnId}' has no result for outcome '${input.event.outcome}'`,
		);
	}
	const item = input.spec.itemCodec.parse(input.iteration.item);
	const value = await yieldResult({
		ctx: {
			...input.ctx,
			item,
			itemKey: input.iteration.itemKey,
			itemLabel: input.iteration.itemLabel,
			itemIndex: input.iteration.itemIndex,
			itemCount: input.iteration.itemCount,
		},
		event: input.event,
	});
	let result: unknown;
	try {
		result = input.spec.resultCodec.parse(value);
	} catch (error) {
		throw new SafeOutcomePlanningError(
			"invalid_mapped_result",
			`Mapped turn '${input.turnId}' produced an invalid result for item '${input.iteration.itemKey}': ${errorMessage(error)}`,
		);
	}
	return toJsonValue(
		input.spec.resultCodec.serialize(result),
		`Mapped turn '${input.turnId}' result for item '${input.iteration.itemKey}'`,
	);
}

/** Collects ordered results once and resolves the turn's single business route. @internal */
export async function collectMappedResults<TParams, TState>(input: {
	/** @internal */
	turnId: TurnId;
	/** @internal */
	spec: MappedLlmTurnSpec<TParams, TState>;
	/** @internal */
	ctx: MappedTurnServerContext<TParams, TState>;
	/** Serialized results in frozen item order. @internal */
	resultJsons: readonly string[];
}): Promise<MappedCollectResult<TState>> {
	const results = input.resultJsons.map((json, index) => {
		try {
			return input.spec.resultCodec.parse(JSON.parse(json));
		} catch (error) {
			throw new SafeOutcomePlanningError(
				"invalid_mapped_result",
				`Mapped turn '${input.turnId}' stored an invalid result at item ${index}: ${errorMessage(error)}`,
			);
		}
	});
	const state = await input.spec.collect(input.ctx, results);
	const routing = input.spec.routing;
	if (routing.kind === "static") {
		return {
			state,
			route: {
				trigger: mappedCollectTrigger(),
				...(routing.to !== undefined ? { nextTurnId: routing.to } : {}),
				...(routing.lifecycleStatus !== undefined
					? { lifecycleStatus: routing.lifecycleStatus }
					: {}),
			},
		};
	}
	const branchId = await routing.choose({ ...input.ctx, state });
	if (!Object.hasOwn(routing.branches, branchId)) {
		throw new Error(
			`Mapped turn '${input.turnId}' collection selected unknown branch '${branchId}'`,
		);
	}
	return {
		state,
		route: { trigger: mappedCollectTrigger(branchId), nextTurnId: routing.branches[branchId] },
	};
}
