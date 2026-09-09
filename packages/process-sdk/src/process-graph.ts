import type {
	ProcessSemanticEntryRefKey,
	ProcessTurnTransition,
	ProcessTurnType,
	SerializedProcessGraph,
	TurnId,
} from "@leitwerk-dev/domain";
import { isValidProcessProductName } from "@leitwerk-dev/domain";
import type { TurnDefinition } from "./define-process.js";
import type { ExtensionProcessDefinition, ProcessTurnBinding } from "./extension-api.js";
import { getProcessTurnTransitions } from "./process-definition-internals.js";

export type ProcessGraphSource = ExtensionProcessDefinition<unknown, unknown>;
export type ProcessGraphRegistry = ReadonlyMap<string, ProcessGraphSource>;

export interface ProcessGraphTurnView {
	turnType: ProcessTurnType;
	description: string;
	transitions: readonly ProcessTurnTransition[];
	reviewProduct?: string;
	resultSemanticRef?: ProcessSemanticEntryRefKey;
	publishedProduct?: string;
	publishedProducts?: readonly string[];
	consumedProducts?: readonly string[];
	optionalConsumedProducts?: readonly string[];
	requiredSemanticMarkdownRefs?: readonly ProcessSemanticEntryRefKey[];
	optionalSemanticMarkdownRefs?: readonly ProcessSemanticEntryRefKey[];
	turnResultMarkdownRequired?: boolean;
}

export interface ProcessGraphView {
	id: string;
	primaryEntryTurnId: TurnId;
	entryTurnIds: ReadonlySet<TurnId>;
	happyPath: readonly TurnId[] | null;
	turns: ReadonlyMap<TurnId, ProcessGraphTurnView>;
}

function turnPublishedProducts(definition: TurnDefinition<unknown, unknown>): string[] {
	const products = new Set<string>();
	if (definition.kind === "human") {
		for (const action of Object.values(definition.actions)) {
			for (const field of action.form?.fields ?? []) {
				if (field.publish) {
					products.add(
						typeof field.publish === "object" && field.publish.product
							? field.publish.product
							: field.id,
					);
				}
			}
		}
		for (const action of Object.values(definition.externalActions ?? {})) {
			if (action.publishInput) {
				products.add(action.publishInput.productName);
			}
		}
	} else if (definition.kind === "llm" || definition.kind === "automatic") {
		for (const outcome of Object.values(definition.outcomes ?? {})) {
			if (typeof outcome?.publishedProduct === "string") {
				products.add(outcome.publishedProduct);
			}
		}
	}
	return [...products];
}

function toTurnView(
	binding: ProcessTurnBinding<TurnDefinition<unknown, unknown>>,
): ProcessGraphTurnView {
	const definition = binding.definition;
	const publishedProducts = turnPublishedProducts(definition);
	return {
		turnType: definition.kind,
		description: definition.description,
		transitions: getProcessTurnTransitions(binding),
		...(definition.kind === "human" && definition.reviewProduct
			? { reviewProduct: definition.reviewProduct }
			: {}),
		...(definition.kind === "llm" && definition.resultSemanticRef
			? { resultSemanticRef: definition.resultSemanticRef }
			: {}),
		...(definition.kind === "llm" && definition.publishedProduct
			? { publishedProduct: definition.publishedProduct }
			: {}),
		...(publishedProducts.length > 0 ? { publishedProducts } : {}),
		...(definition.kind === "llm" && definition.consumedProducts?.length
			? { consumedProducts: [...definition.consumedProducts] }
			: {}),
		...(definition.kind === "llm" && definition.optionalConsumedProducts?.length
			? { optionalConsumedProducts: [...definition.optionalConsumedProducts] }
			: {}),
		...(definition.kind === "llm" && definition.requiredSemanticMarkdownRefs?.length
			? { requiredSemanticMarkdownRefs: [...definition.requiredSemanticMarkdownRefs] }
			: {}),
		...(definition.kind === "llm" && definition.optionalSemanticMarkdownRefs?.length
			? { optionalSemanticMarkdownRefs: [...definition.optionalSemanticMarkdownRefs] }
			: {}),
		...(definition.kind === "llm" &&
		definition.turnResultMarkdown &&
		"required" in definition.turnResultMarkdown &&
		definition.turnResultMarkdown.required === true
			? { turnResultMarkdownRequired: true }
			: {}),
	};
}

/**
 * Runtime adapter from an extension process definition to the internal graph view.
 * All server lifecycle, validation, model-selection and serialization code should use this view
 * instead of maintaining a second graph representation.
 */
export function toProcessGraphView(definition: ProcessGraphSource): ProcessGraphView {
	const turns = new Map<TurnId, ProcessGraphTurnView>();
	for (const [turnId, binding] of definition.turns) {
		turns.set(turnId, toTurnView(binding));
	}
	return {
		id: definition.id,
		primaryEntryTurnId: definition.entryTurnId,
		entryTurnIds: new Set([definition.entryTurnId, ...(definition.alternateEntryTurnIds ?? [])]),
		happyPath: definition.happyPath ? [...definition.happyPath] : null,
		turns,
	};
}

export function hasProcessGraph(registry: ProcessGraphRegistry, processId: string): boolean {
	return registry.has(processId);
}

export function getProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
): ProcessGraphView {
	const definition = registry.get(processId);
	if (!definition) {
		throw new Error(`Unknown process definition: ${processId}`);
	}
	return toProcessGraphView(definition);
}

export function getAllProcessGraphs(registry: ProcessGraphRegistry): readonly ProcessGraphView[] {
	return [...registry.values()].map((definition) => toProcessGraphView(definition));
}

export function getProcessTurnGraph(
	registry: ProcessGraphRegistry,
	processId: string,
	turnId: TurnId,
): ProcessGraphTurnView | undefined {
	return getProcessGraph(registry, processId).turns.get(turnId);
}

export function getTurnTransitionsForProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
	turnId: TurnId,
): readonly ProcessTurnTransition[] {
	return getProcessTurnGraph(registry, processId, turnId)?.transitions ?? [];
}

export function getReachableTurnIdsForProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
): readonly TurnId[] {
	return [...getProcessGraph(registry, processId).turns.keys()];
}

export function isTurnAvailableForProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
	turnId: TurnId,
): boolean {
	return getProcessGraph(registry, processId).turns.has(turnId);
}

export function serializeProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
): SerializedProcessGraph {
	const definition = getProcessGraph(registry, processId);
	const turnTransitions: Record<TurnId, ProcessTurnTransition[]> = {};
	for (const [turnId, turn] of definition.turns) {
		turnTransitions[turnId] = turn.transitions.map((transition) => ({ ...transition }));
	}
	return {
		id: definition.id,
		entryTurnIds: [...definition.entryTurnIds],
		reachableTurnIds: [...definition.turns.keys()],
		turnTransitions,
	};
}

export function listLlmTurnIdsForProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
): readonly TurnId[] {
	return [...getProcessGraph(registry, processId).turns.entries()]
		.filter(([, turn]) => turn.turnType === "llm")
		.map(([turnId]) => turnId);
}

function isTerminalLifecycleStatus(value: string | undefined): value is "completed" | "aborted" {
	return value === "completed" || value === "aborted";
}

export function validateProcessGraphEntryTurns(graph: ProcessGraphView): readonly string[] {
	const errors: string[] = [];
	for (const turnId of graph.entryTurnIds) {
		if (!graph.turns.has(turnId)) {
			errors.push(`Entry turn '${turnId}' is not declared in turns`);
		}
	}
	return errors;
}

export function validateProcessGraphProducts(graph: ProcessGraphView): readonly string[] {
	const errors: string[] = [];
	const publishedProducts = new Set<string>();
	for (const [turnId, turn] of graph.turns) {
		const productNames = [
			...(turn.publishedProduct ? [turn.publishedProduct] : []),
			...(turn.publishedProducts ?? []),
		];
		for (const productName of productNames) {
			if (!isValidProcessProductName(productName)) {
				errors.push(`Turn '${turnId}' publishes invalid product '${productName}'`);
				continue;
			}
			publishedProducts.add(productName);
		}
	}
	for (const [turnId, turn] of graph.turns) {
		for (const productName of [
			...(turn.consumedProducts ?? []),
			...(turn.optionalConsumedProducts ?? []),
		]) {
			if (!isValidProcessProductName(productName)) {
				errors.push(`Turn '${turnId}' consumes invalid product '${productName}'`);
				continue;
			}
			if (!publishedProducts.has(productName)) {
				errors.push(
					`Turn '${turnId}' consumes product '${productName}' that is never published by this process`,
				);
			}
		}
	}
	return errors;
}

export function validateProcessGraphTurnTransitions(graph: ProcessGraphView): readonly string[] {
	const errors: string[] = [];
	for (const [turnId, turn] of graph.turns) {
		for (const transition of turn.transitions) {
			const hasNextTurn = transition.nextTurnId !== undefined;
			const hasLifecycleStatus = transition.lifecycleStatus !== undefined;
			if (hasNextTurn === hasLifecycleStatus) {
				errors.push(
					`Turn transition from '${turnId}' must declare exactly one target: nextTurnId or lifecycleStatus`,
				);
				continue;
			}
			if (transition.nextTurnId !== undefined && !graph.turns.has(transition.nextTurnId)) {
				errors.push(
					`Turn transition from '${turnId}' references undeclared nextTurnId '${transition.nextTurnId}'`,
				);
			}
			if (
				transition.lifecycleStatus !== undefined &&
				!isTerminalLifecycleStatus(transition.lifecycleStatus)
			) {
				errors.push(
					`Turn transition from '${turnId}' references invalid lifecycleStatus '${transition.lifecycleStatus}'`,
				);
			}
		}
	}
	return errors;
}
