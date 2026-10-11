import { isUnknownRecord } from "@leitwerk-dev/domain";
import type {
	LlmTurnDefinition,
	OutcomeParameterContext,
	ProcessToolOutcomeSpec,
} from "./define-process.js";
import type { MappedTurnIteration } from "./mapped-turn.js";
import { compileOutcomeParameters, outcomeCallParameters } from "./outcome-schema.js";
import type { OutcomeToolSpec, TurnResultMarkdownBehavior } from "./types.js";

/** Serializable contract owned by a prepared turn start. @internal */
export interface ResolvedOutcomeContract {
	/** @internal */
	version: 1;
	/** @internal */
	outcomes: Record<string, OutcomeToolSpec>;
	/** @internal */
	turnResultMarkdown: TurnResultMarkdownBehavior | null;
	/** @internal */
	publishedProduct: string | null;
}

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		Object.freeze(value);
		for (const child of Object.values(value)) freeze(child);
	}
	return value;
}

/** Resolve once on the server, before worker I/O; callbacks receive immutable copies. @internal */
export function resolveOutcomeContract<TParams, TState>(
	turn: LlmTurnDefinition<string, TParams, TState>,
	ctx: OutcomeParameterContext<TParams, TState>,
	iteration?: MappedTurnIteration,
): ResolvedOutcomeContract {
	const context = freeze(
		structuredClone({
			...ctx,
			...(iteration
				? {
						...iteration,
						item: turn.forEach?.itemCodec.parse(iteration.item) ?? iteration.item,
					}
				: {}),
		}),
	);
	const outcomes: Record<string, OutcomeToolSpec> = {};
	for (const [name, value] of Object.entries(turn.outcomes ?? {})) {
		const spec = value as ProcessToolOutcomeSpec<TParams, TState>;
		if (spec.resolveParameters && turn.forEach && !iteration)
			throw new Error(`Outcome '${name}' needs its frozen mapped item`);
		const resolved = spec.resolveParameters ? spec.resolveParameters(context) : {};
		if (!isUnknownRecord(resolved) || typeof resolved.then === "function")
			throw new Error(`Outcome '${name}' parameter resolver must return a synchronous object`);
		const contract: OutcomeToolSpec = {
			description: spec.description,
			parameters: { ...spec.parameters, ...resolved },
			...(spec.strictSchema ? { strictSchema: true } : {}),
			...(spec.publishedProduct ? { publishedProduct: spec.publishedProduct } : {}),
			...(spec.turnResultMarkdownParameter
				? { turnResultMarkdownParameter: spec.turnResultMarkdownParameter }
				: {}),
			...(spec.resultSummaryParameter
				? { resultSummaryParameter: spec.resultSummaryParameter }
				: {}),
		};
		compileOutcomeParameters(
			outcomeCallParameters(
				contract,
				turn.turnResultMarkdown?.mode === "outcome_tool_argument"
					? turn.turnResultMarkdown.parameterName
					: undefined,
			),
			contract.strictSchema,
		);
		outcomes[name] = contract;
	}
	return JSON.parse(
		JSON.stringify({
			version: 1,
			outcomes,
			turnResultMarkdown: turn.turnResultMarkdown ?? null,
			publishedProduct: turn.publishedProduct ?? null,
		}),
	) as ResolvedOutcomeContract;
}

/** Overlay the frozen declaration while retaining current executable handlers. @internal */
export function applyOutcomeContract<TOutcome extends string, TParams, TState>(
	turn: LlmTurnDefinition<TOutcome, TParams, TState>,
	snapshot: unknown,
): LlmTurnDefinition<TOutcome, TParams, TState> {
	if (!isUnknownRecord(snapshot) || snapshot.version !== 1 || !isUnknownRecord(snapshot.outcomes))
		throw new Error("Invalid frozen outcome contract");
	const contract = snapshot as unknown as ResolvedOutcomeContract;
	const outcomes: Record<string, ProcessToolOutcomeSpec<TParams, TState>> = {};
	for (const [name, spec] of Object.entries(contract.outcomes)) {
		const current = turn.outcomes?.[name as TOutcome];
		if (!current) throw new Error(`Frozen outcome '${name}' no longer has an executable handler`);
		compileOutcomeParameters(
			outcomeCallParameters(
				spec,
				contract.turnResultMarkdown?.mode === "outcome_tool_argument"
					? contract.turnResultMarkdown.parameterName
					: undefined,
			),
			spec.strictSchema,
		);
		const {
			resolveParameters,
			strictSchema,
			publishedProduct,
			turnResultMarkdownParameter,
			resultSummaryParameter,
			...handler
		} = current;
		outcomes[name] = { ...handler, ...spec };
	}
	return {
		...turn,
		outcomes,
		turnResultMarkdown: contract.turnResultMarkdown ?? undefined,
		publishedProduct: contract.publishedProduct ?? undefined,
	} as LlmTurnDefinition<TOutcome, TParams, TState>;
}
