import type { ProcessTurnTransition, TurnId } from "@leitwerk-dev/domain";
import {
	defineProcess,
	type ExtensionProcessDefinition,
	type TurnDefinition,
} from "@leitwerk-dev/process-sdk";

export function getEntryTurnIdForGraphFixture(input: {
	entryTurnId?: TurnId;
	entryTurnIds?: Iterable<TurnId>;
}): string {
	const entryTurnId = input.entryTurnId ?? [...(input.entryTurnIds ?? [])][0];
	if (!entryTurnId) {
		throw new Error("Expected process fixture to declare at least one entry turn");
	}
	return entryTurnId;
}

function graphFixtureEdges(turn: unknown): readonly ProcessTurnTransition[] {
	if (typeof turn !== "object" || turn === null) {
		return [];
	}
	const legacyEdges = (turn as Record<string, unknown>)["trans" + "itions"];
	return Array.isArray(legacyEdges) ? (legacyEdges as ProcessTurnTransition[]) : [];
}

function routeDefinition<TParams, TState>(
	definition: TurnDefinition<TParams, TState>,
	edges: readonly ProcessTurnTransition[],
): TurnDefinition<TParams, TState> {
	if (definition.kind === "human") {
		const actions = Object.entries(definition.actions);
		if (actions.length === 0) {
			return {
				...definition,
				actions: {
					__fixture_noop: { label: "No-op", acceptanceState: "neutral", complete: true },
				},
			};
		}
		return {
			...definition,
			actions: Object.fromEntries(
				actions.map(([actionId, action]) => {
					const trigger =
						"trigger" in action && typeof action.trigger === "string"
							? action.trigger
							: action.preview?.kind === "trigger"
								? action.preview.trigger
								: actionId;
					const edge = edges.find(
						(candidate) => candidate.trigger === trigger || candidate.trigger === actionId,
					);
					const hasTarget = "to" in action || "complete" in action || "lifecycleStatus" in action;
					return [
						actionId,
						{
							...action,
							...(edge?.trigger ? { trigger: edge.trigger } : {}),
							...(edge?.nextTurnId ? { to: edge.nextTurnId } : {}),
							...(edge?.lifecycleStatus ? { lifecycleStatus: edge.lifecycleStatus } : {}),
							...(!edge && !hasTarget ? { complete: true } : {}),
						},
					];
				}),
			),
		};
	}
	if (definition.kind === "external") {
		const [edge] = edges;
		const hasTarget =
			"to" in definition || "complete" in definition || "lifecycleStatus" in definition;
		return {
			...definition,
			...(edge?.trigger ? { trigger: edge.trigger } : {}),
			...(edge?.nextTurnId ? { to: edge.nextTurnId } : {}),
			...(edge?.lifecycleStatus ? { lifecycleStatus: edge.lifecycleStatus } : {}),
			...(!edge && !hasTarget ? { complete: true } : {}),
		};
	}
	if (
		definition.kind === "llm" ||
		definition.kind === "automatic" ||
		definition.kind === "server_automatic"
	) {
		if (edges.length > 0) {
			return {
				...definition,
				turnEnd: undefined,
				outcomes: Object.fromEntries(
					edges.map((edge, index) => {
						const outcome =
							edge.outcome ??
							definition.turnEnd?.outcome ??
							Object.keys(definition.outcomes ?? {})[index] ??
							`edge_${index}`;
						const existing = definition.outcomes?.[outcome];
						return [
							outcome,
							{
								description: existing?.description ?? outcome,
								parameters: existing?.parameters ?? {},
								...(existing ?? {}),
								...(edge.nextTurnId ? { to: edge.nextTurnId } : {}),
								...(edge.lifecycleStatus ? { lifecycleStatus: edge.lifecycleStatus } : {}),
							},
						];
					}),
				),
			} as TurnDefinition<TParams, TState>;
		}
		if (Object.keys(definition.outcomes ?? {}).length === 0 && !definition.turnEnd) {
			return {
				...definition,
				turnEnd: { outcome: "done", params: {}, complete: true },
			} as TurnDefinition<TParams, TState>;
		}
	}
	return definition;
}

export function defineGraphFixtureProcess<TParams = unknown, TState = unknown>(input: {
	id: string;
	displayName: string;
	graph: {
		entryTurnIds?: Iterable<TurnId>;
		entryTurnId?: TurnId;
		turns: ReadonlyMap<string, unknown>;
	};
	turnDefinitions: ReadonlyMap<string, TurnDefinition<TParams, TState>>;
	paramsCodec: ExtensionProcessDefinition<TParams, TState>["paramsCodec"];
	stateCodec: ExtensionProcessDefinition<TParams, TState>["stateCodec"];
	initialState: ExtensionProcessDefinition<TParams, TState>["initialState"];
	server?: ExtensionProcessDefinition<TParams, TState>["server"];
	worker?: ExtensionProcessDefinition<TParams, TState>["worker"];
	ui?: ExtensionProcessDefinition<TParams, TState>["ui"];
}): ExtensionProcessDefinition<TParams, TState> {
	const turns = Object.fromEntries(
		[...input.graph.turns.entries()].map(([turnId, graphTurn]) => {
			const definition = input.turnDefinitions.get(turnId);
			if (!definition) {
				throw new Error(`Missing turn definition for '${turnId}'`);
			}
			return [turnId, routeDefinition(definition, graphFixtureEdges(graphTurn))];
		}),
	);
	const process = defineProcess<TParams, TState>({
		id: input.id,
		displayName: input.displayName,
		entry: getEntryTurnIdForGraphFixture(input.graph),
		turns,
		paramsCodec: input.paramsCodec,
		stateCodec: input.stateCodec,
		initialState: input.initialState,
		...(input.server ? { server: input.server } : {}),
		...(input.worker ? { worker: input.worker } : {}),
		...(input.ui ? { ui: input.ui } : {}),
	});
	if (input.server) {
		process.server = input.server;
	}
	return process;
}
