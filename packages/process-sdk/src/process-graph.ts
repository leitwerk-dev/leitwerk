import type {
	ProcessFlowEdge,
	ProcessFlowNode,
	ProcessFlowTool,
	ProcessSemanticEntryRefKey,
	ProcessTurnTransition,
	ProcessTurnType,
	SerializedProcessGraph,
	TurnId,
} from "@leitwerk-dev/domain";
import { humanizeProcessLabel, isValidProcessProductName, trimToNull } from "@leitwerk-dev/domain";
import type { TurnDefinition } from "./define-process.js";
import type { ExtensionProcessDefinition, ProcessTurnBinding } from "./extension-api.js";
import { getProcessTurnTransitions } from "./process-definition-internals.js";

/** @internal */
export type ProcessGraphSource = ExtensionProcessDefinition<unknown, unknown>;
/** @internal */
export type ProcessGraphRegistry = ReadonlyMap<string, ProcessGraphSource>;

/** @internal */
export interface ProcessGraphTurnView {
	/** @internal */
	turnType: ProcessTurnType;
	/** @internal */
	description: string;
	/** Definition-only display metadata; never evaluates turn callbacks. @internal */
	repetition?: ProcessFlowNode["repetition"];
	/** @internal */
	tools?: ProcessFlowTool[];
	/** @internal */
	hasDynamicTools?: boolean;
	/** @internal */
	transitions: readonly (ProcessTurnTransition & Pick<ProcessFlowEdge, "condition">)[];
	/** Display labels for external triggers; durable route identities remain unchanged. @internal */
	transitionLabels?: Readonly<Record<string, string>>;
	/** @internal */
	reviewProduct?: string;
	/** @internal */
	resultSemanticRef?: ProcessSemanticEntryRefKey;
	/** @internal */
	publishedProduct?: string;
	/** @internal */
	publishedProducts?: readonly string[];
	/** @internal */
	consumedProducts?: readonly string[];
	/** @internal */
	optionalConsumedProducts?: readonly string[];
	/** @internal */
	requiredSemanticMarkdownRefs?: readonly ProcessSemanticEntryRefKey[];
	/** @internal */
	optionalSemanticMarkdownRefs?: readonly ProcessSemanticEntryRefKey[];
	/** @internal */
	turnResultMarkdownRequired?: boolean;
}

/** @internal */
export interface ProcessGraphView {
	/** @internal */
	id: string;
	/** @internal */
	primaryEntryTurnId: TurnId;
	/** @internal */
	entryTurnIds: ReadonlySet<TurnId>;
	/** @internal */
	happyPath: readonly TurnId[] | null;
	/** @internal */
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
	} else if (definition.kind === "llm" || definition.kind === "automatic") {
		for (const outcome of Object.values(definition.outcomes ?? {})) {
			if (typeof outcome?.publishedProduct === "string") {
				products.add(outcome.publishedProduct);
			}
		}
	}
	if (definition.kind !== "external") {
		for (const action of Object.values(definition.externalActions ?? {})) {
			if (action.publishInput) {
				products.add(action.publishInput.productName);
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
	const transitionLabels =
		definition.kind !== "external"
			? Object.fromEntries(
					Object.entries(definition.externalActions ?? {}).flatMap(([id, action]) => {
						const label = action.label ?? action.source.label;
						return label ? [[`external:${id}`, label]] : [];
					}),
				)
			: {};
	const view: ProcessGraphTurnView = {
		turnType: definition.kind,
		description: definition.description,
		transitions: getProcessTurnTransitions(binding).map((transition) => {
			const outcome =
				(definition.kind === "llm" || definition.kind === "automatic") && transition.outcome
					? definition.outcomes?.[transition.outcome]
					: undefined;
			if (!outcome || !("branches" in outcome) || !transition.trigger) return transition;
			const branch = Object.entries(outcome.branches).find(
				([id, spec]) => (spec.trigger ?? id) === transition.trigger,
			)?.[1];
			if (!branch) return transition;
			const description = trimToNull(branch.description);
			return {
				...transition,
				condition: {
					label: trimToNull(branch.label) ?? humanizeProcessLabel(transition.trigger),
					...(description ? { description } : {}),
				},
			};
		}),
		...(Object.keys(transitionLabels).length ? { transitionLabels } : {}),
		...(definition.kind === "human" && definition.reviewProduct
			? { reviewProduct: definition.reviewProduct }
			: {}),
		...(publishedProducts.length > 0 ? { publishedProducts } : {}),
	};
	if (definition.kind === "llm") {
		if (definition.forEach) view.repetition = "sequential";
		view.tools = declaredFlowTools(definition);
		view.hasDynamicTools = definition.resolveIntegrationTools !== undefined;
		if (definition.resultSemanticRef) view.resultSemanticRef = definition.resultSemanticRef;
		if (definition.publishedProduct) view.publishedProduct = definition.publishedProduct;
		if (definition.consumedProducts?.length)
			view.consumedProducts = [...definition.consumedProducts];
		if (definition.optionalConsumedProducts?.length)
			view.optionalConsumedProducts = [...definition.optionalConsumedProducts];
		if (definition.requiredSemanticMarkdownRefs?.length)
			view.requiredSemanticMarkdownRefs = [...definition.requiredSemanticMarkdownRefs];
		if (definition.optionalSemanticMarkdownRefs?.length)
			view.optionalSemanticMarkdownRefs = [...definition.optionalSemanticMarkdownRefs];
		if (
			definition.turnResultMarkdown &&
			"required" in definition.turnResultMarkdown &&
			definition.turnResultMarkdown.required === true
		)
			view.turnResultMarkdownRequired = true;
	}
	return view;
}

function declaredFlowTools(
	definition: Extract<TurnDefinition, { kind: "llm" }>,
): ProcessFlowTool[] {
	const tool = (
		name: string,
		category: ProcessFlowTool["category"],
		description: string | null = null,
	): ProcessFlowTool => ({ name, category, description });
	return [
		...definition.availableTools.map((name) => tool(name, "workspace")),
		...(definition.integrationTools ?? []).map((name) => tool(name, "integration")),
		...(definition.askQuestions
			? [tool("ask_questions", "question", "Ask the operator structured questions.")]
			: []),
		...Object.entries(definition.outcomes ?? {}).flatMap(([name, outcome]) =>
			outcome ? [tool(name, "outcome", outcome.description)] : [],
		),
	];
}

/**
 * Runtime adapter from an extension process definition to the internal graph view.
 * All server lifecycle, validation, model-selection and serialization code should use this view
 * instead of maintaining a second graph representation.
 */
/** @internal */
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

/** @internal */
export function hasProcessGraph(registry: ProcessGraphRegistry, processId: string): boolean {
	return registry.has(processId);
}

/** @internal */
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

/** @internal */
export function getAllProcessGraphs(registry: ProcessGraphRegistry): readonly ProcessGraphView[] {
	return [...registry.values()].map((definition) => toProcessGraphView(definition));
}

/** @internal */
export function getProcessTurnGraph(
	registry: ProcessGraphRegistry,
	processId: string,
	turnId: TurnId,
): ProcessGraphTurnView | undefined {
	return getProcessGraph(registry, processId).turns.get(turnId);
}

/** @internal */
export function getTurnTransitionsForProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
	turnId: TurnId,
): readonly ProcessTurnTransition[] {
	return getProcessTurnGraph(registry, processId, turnId)?.transitions ?? [];
}

/** @internal */
export function getReachableTurnIdsForProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
): readonly TurnId[] {
	return [...getProcessGraph(registry, processId).turns.keys()];
}

/** @internal */
export function isTurnAvailableForProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
	turnId: TurnId,
): boolean {
	return getProcessGraph(registry, processId).turns.has(turnId);
}

/** @internal */
export function serializeProcessGraph(
	registry: ProcessGraphRegistry,
	processId: string,
): SerializedProcessGraph {
	const definition = getProcessGraph(registry, processId);
	const turnTransitions: Record<TurnId, ProcessTurnTransition[]> = {};
	for (const [turnId, turn] of definition.turns) {
		turnTransitions[turnId] = turn.transitions.map(
			({ condition: _condition, ...transition }) => transition,
		);
	}
	return {
		id: definition.id,
		entryTurnIds: [...definition.entryTurnIds],
		reachableTurnIds: [...definition.turns.keys()],
		turnTransitions,
	};
}

/** @internal */
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

/** @internal */
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

/** @internal */
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
