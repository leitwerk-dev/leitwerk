import type {
	ProcessInstance,
	ProcessProject,
	ProcessSemanticEntryRefKey,
	ProcessTurnTerminalLifecycleStatus,
} from "@leitwerk-dev/domain";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type {
	BuiltServerProcessDefinition,
	ExtensionProcessDefinition,
	ProcessActionDefinition,
	ProcessActionExecutionSource,
	ProcessActionPreviewDefinition,
	ProcessActionSchedulingDefinition,
	ServerProcessContext,
	TurnAcceptanceState,
	TurnDefinition,
} from "@leitwerk-dev/process-sdk";
import {
	createServerProcessBuilder,
	getExternalActionArmingId,
	getExternalSourceTransitionId,
	isAutomaticTurnDefinition,
	isExternalTurnDefinition,
	isHumanTurnDefinition,
	resolveHumanTurnView,
	toProcessGraphView,
} from "@leitwerk-dev/process-sdk";
import type {
	ProcessExternalSourceSummary,
	ProcessSelectedTurnSummary,
} from "@leitwerk-dev/protocol/http-contracts";

export interface ProcessContextData {
	params: unknown;
	state: unknown;
}

export interface ResolvedUiHumanTurnAction {
	kind: "ui_human_action";
	turnId: string;
	turnType: "human";
	semanticEntryRefKey: ProcessSemanticEntryRefKey | null;
	acceptanceState: TurnAcceptanceState;
}

export interface ResolvedExternalHumanTriggerAction {
	kind: "external_human_trigger";
	turnId: string;
	turnType: "external";
	semanticEntryRefKey: ProcessSemanticEntryRefKey | null;
	acceptanceState: TurnAcceptanceState;
	externalTrigger: { id: string; actionId: string; label: string; description: string };
}

export type ResolvedTurnScopedAction =
	| ResolvedUiHumanTurnAction
	| ResolvedExternalHumanTriggerAction;

interface ResolvedAction<Definition> {
	definition: Definition;
	candidateSelectedTurnId: string | null;
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus | null;
}

export type ResolvedActionPreview = ResolvedAction<ProcessActionPreviewDefinition>;
export type ResolvedActionScheduling = ResolvedAction<ProcessActionSchedulingDefinition>;

export interface VisibleProcessActionSummary {
	id: string;
	label: string;
	description: string | null;
	form?: ProcessActionDefinition["form"];
	preview: ResolvedActionPreview | null;
}

export interface ProcessActionRegistry {
	getAction(processId: string, actionId: string): ProcessActionDefinition | undefined;
	isTurnScopedAction(processId: string, actionId: string): boolean;
	listVisibleActions(processId: string, ctx: ServerProcessContext): VisibleProcessActionSummary[];
	getSelectedTurnSummary(
		processId: string,
		process: ProcessInstance,
		projects?: readonly ProcessProject[],
	): ProcessSelectedTurnSummary | null;
	getServerDefinition(processId: string): BuiltServerProcessDefinition | undefined;
	getTurnDefinition(
		processId: string,
		turnId: string,
	): TurnDefinition<unknown, unknown> | undefined;
	getProcessGraph(processId: string): ExtensionProcessDefinition | undefined;
	getProcessDisplayName(processId: string): string | undefined;
	resolveContextData(
		processId: string,
		process: Pick<ProcessInstance, "paramsJson" | "stateJson">,
	): ProcessContextData;
	resolveTurnScopedAction(
		processId: string,
		process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
		actionId: string,
		source: ProcessActionExecutionSource,
	): ResolvedTurnScopedAction | null;
	resolveActionPreview(
		processId: string,
		process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
		actionId: string,
	): ResolvedActionPreview | null;
	resolveActionScheduling(
		processId: string,
		process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
		actionId: string,
	): ResolvedActionScheduling | null;
}

export function resolveTurnIntegrationToolNames(
	registry: Pick<ProcessActionRegistry, "getTurnDefinition" | "resolveContextData">,
	process: Pick<ProcessInstance, "processId" | "paramsJson" | "stateJson">,
	turnId: string,
): readonly string[] {
	const turn = registry.getTurnDefinition(process.processId, turnId);
	if (turn?.kind !== "llm" && turn?.kind !== "automatic") return [];
	const dynamic =
		turn.kind === "llm" && turn.resolveIntegrationTools
			? (() => {
					const context = registry.resolveContextData(process.processId, process);
					return turn.resolveIntegrationTools?.(context.params, context.state) ?? [];
				})()
			: [];
	return [...new Set([...(turn.integrationTools ?? []), ...dynamic])];
}

function resolveProcessContextData(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "paramsJson" | "stateJson">,
): ProcessContextData {
	if (!processDef) {
		return { params: {}, state: {} };
	}

	const params = process.paramsJson
		? processDef.paramsCodec.parse(JSON.parse(process.paramsJson))
		: processDef.paramsCodec.parse(undefined);
	const state = process.stateJson
		? processDef.stateCodec.parse(JSON.parse(process.stateJson))
		: processDef.initialState(params);
	return { params, state };
}

function resolveCurrentTurnForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
): { turnId: string; turnDef: TurnDefinition<unknown, unknown> } | null {
	if (!processDef || !process.selectedTurnId) {
		return null;
	}

	const selectedTurn = processDef.turns.get(process.selectedTurnId)?.definition;
	if (!selectedTurn) {
		return null;
	}

	return { turnId: process.selectedTurnId, turnDef: selectedTurn };
}

function listExternalTriggers(
	turnId: string,
	turnDef: TurnDefinition<unknown, unknown>,
	ctx: {
		process: ProcessInstance;
		projects: readonly ProcessProject[];
		params: unknown;
		state: unknown;
	},
): ProcessExternalSourceSummary[] {
	if (isHumanTurnDefinition(turnDef)) {
		const view = resolveHumanTurnView({ turnId, turn: turnDef });
		return [
			...view.externalTriggers.map((trigger) => ({
				id: trigger.id,
				kind: "human_action_external_trigger",
				label: trigger.label,
				description: trigger.description,
			})),
			...view.externalActions
				.filter((action) => {
					const definition = turnDef.externalActions?.[action.externalActionId];
					return !definition?.when || definition.when(ctx);
				})
				.map((action) => ({
					id: action.id,
					externalActionId: action.externalActionId,
					kind: action.sourceKind,
					sourceKind: action.sourceKind,
					label: action.label,
					description: action.description,
				})),
		];
	}
	if (isExternalTurnDefinition(turnDef)) {
		return turnDef.transitions.map((transition, index) => ({
			id: getExternalSourceTransitionId({ turnId, source: transition.source, index }),
			kind: transition.source.kind,
			label: transition.source.label ?? null,
			description: transition.source.description ?? null,
		}));
	}
	if (isAutomaticTurnDefinition(turnDef) && ctx.process.lifecycleStatus === "waiting") {
		return Object.entries(turnDef.externalActions ?? {})
			.filter(([, action]) => !action.when || action.when(ctx))
			.map(([externalActionId, action]) => ({
				id: getExternalActionArmingId({ turnId, externalActionId }),
				externalActionId,
				kind: action.source.kind,
				sourceKind: action.source.kind,
				label: action.label ?? action.source.label ?? null,
				description: action.description ?? action.source.description ?? null,
			}));
	}
	return [];
}

function resolveCurrentVisibleActionForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
	actionId: string,
) {
	const currentTurn = resolveCurrentTurnForProcess(processDef, process);
	if (!currentTurn || !isHumanTurnDefinition(currentTurn.turnDef)) {
		return null;
	}
	const view = resolveHumanTurnView({ turnId: currentTurn.turnId, turn: currentTurn.turnDef });
	return view.actions.find((candidate) => candidate.actionId === actionId) ?? null;
}

function isTurnScopedActionForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	actionId: string,
): boolean {
	if (!processDef) {
		return false;
	}
	for (const [turnId, { definition: turnDef }] of processDef.turns) {
		if (isHumanTurnDefinition(turnDef)) {
			const view = resolveHumanTurnView({ turnId, turn: turnDef });
			if (
				view.actions.some((action) => action.actionId === actionId) ||
				view.externalTriggers.some((trigger) => trigger.actionId === actionId)
			) {
				return true;
			}
		}
	}
	return false;
}

function buildSelectedTurnSummaryForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: ProcessInstance,
	projects: readonly ProcessProject[] = [],
): ProcessSelectedTurnSummary | null {
	const currentTurn = resolveCurrentTurnForProcess(processDef, process);
	if (!currentTurn) {
		return null;
	}
	const { params, state } = resolveProcessContextData(processDef, process);
	return {
		turnId: currentTurn.turnId,
		kind: currentTurn.turnDef.kind,
		description: currentTurn.turnDef.description,
		commentary: isHumanTurnDefinition(currentTurn.turnDef)
			? (currentTurn.turnDef.commentary ?? null)
			: null,
		externalTriggers: listExternalTriggers(currentTurn.turnId, currentTurn.turnDef, {
			process,
			projects,
			params,
			state,
		}),
	};
}

function resolveActionTarget<
	Definition extends ProcessActionPreviewDefinition | ProcessActionSchedulingDefinition,
>(
	definition: Definition | null,
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId">,
): ResolvedAction<Definition> | null {
	if (!definition) return null;
	const metadata: ProcessActionPreviewDefinition | ProcessActionSchedulingDefinition = definition;
	const preview = "preview" in metadata ? metadata.preview : metadata;
	if (preview.kind === "fixed_turn") {
		return { definition, candidateSelectedTurnId: preview.turnId, lifecycleStatus: null };
	}
	if (preview.kind === "terminal") {
		return { definition, candidateSelectedTurnId: null, lifecycleStatus: preview.lifecycleStatus };
	}
	if (!processDef || !process.selectedTurnId) return null;
	const transitions =
		toProcessGraphView(processDef).turns.get(process.selectedTurnId)?.transitions ?? [];
	const matchingTransitions = transitions.filter(
		(transition) => transition.trigger === preview.trigger,
	);
	if (matchingTransitions.length !== 1) return null;
	const [transition] = matchingTransitions;
	return {
		definition,
		candidateSelectedTurnId: transition.nextTurnId ?? null,
		lifecycleStatus: transition.lifecycleStatus ?? null,
	};
}

function resolveActionPreviewForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
	action: ProcessActionDefinition | undefined,
	actionId: string,
): ResolvedActionPreview | null {
	const visibleAction = resolveCurrentVisibleActionForProcess(processDef, process, actionId);
	const definition =
		visibleAction?.preview ??
		visibleAction?.scheduling?.preview ??
		action?.preview ??
		action?.scheduling?.preview ??
		null;
	return resolveActionTarget(definition, processDef, process);
}

function resolveTurnScopedActionForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
	actionId: string,
	source: ProcessActionExecutionSource,
): ResolvedTurnScopedAction | null {
	const currentTurn = resolveCurrentTurnForProcess(processDef, process);
	if (!currentTurn || !isHumanTurnDefinition(currentTurn.turnDef)) return null;
	const view = resolveHumanTurnView({ turnId: currentTurn.turnId, turn: currentTurn.turnDef });
	const action = view.actions.find((candidate) => candidate.actionId === actionId);
	if (!action) return null;
	const common = {
		turnId: currentTurn.turnId,
		semanticEntryRefKey: currentTurn.turnDef.reviewSemanticRef ?? null,
		acceptanceState: action.acceptanceState,
	};
	if (source !== "external") {
		return { ...common, kind: "ui_human_action", turnType: "human" };
	}
	const externalTrigger = view.externalTriggers.find((trigger) => trigger.actionId === actionId);
	if (!externalTrigger) return null;
	return {
		...common,
		kind: "external_human_trigger",
		turnType: "external",
		externalTrigger: {
			id: externalTrigger.id,
			actionId: externalTrigger.actionId,
			label: externalTrigger.label,
			description: externalTrigger.description,
		},
	};
}

export function buildProcessActionRegistry(
	catalog: Pick<ExtensionCatalog, "processes">,
): ProcessActionRegistry {
	const serverDefs = new Map<string, BuiltServerProcessDefinition>();
	const processDefs = new Map<string, ExtensionProcessDefinition>();

	for (const [processId, processDef] of catalog.processes) {
		processDefs.set(processId, processDef);
		if (!processDef.server) {
			continue;
		}
		const builder = createServerProcessBuilder();
		processDef.server(builder);
		serverDefs.set(processId, builder.getDefinition());
	}

	return {
		getAction(processId, actionId) {
			const def = serverDefs.get(processId);
			if (!def) return undefined;
			return def.actions.get(actionId);
		},

		isTurnScopedAction(processId, actionId) {
			return isTurnScopedActionForProcess(processDefs.get(processId), actionId);
		},

		listVisibleActions(processId: string, ctx: ServerProcessContext) {
			const def = serverDefs.get(processId);
			const processDef = processDefs.get(processId);
			const currentTurn = resolveCurrentTurnForProcess(processDef, ctx.process);
			if (!def || !currentTurn || !isHumanTurnDefinition(currentTurn.turnDef)) {
				return [];
			}

			const view = resolveHumanTurnView({
				turnId: currentTurn.turnId,
				turn: currentTurn.turnDef,
			});
			const visible: VisibleProcessActionSummary[] = [];
			for (const turnAction of view.actions) {
				const action = def.actions.get(turnAction.actionId);
				if (!action) {
					continue;
				}
				visible.push({
					id: action.id,
					label: turnAction.label ?? action.label,
					description: turnAction.description ?? null,
					form: action.form,
					preview: resolveActionPreviewForProcess(processDef, ctx.process, action, action.id),
				});
			}
			return visible;
		},

		getSelectedTurnSummary(processId, process, projects) {
			return buildSelectedTurnSummaryForProcess(processDefs.get(processId), process, projects);
		},

		getServerDefinition(processId) {
			return serverDefs.get(processId);
		},
		getTurnDefinition(processId, turnId) {
			return processDefs.get(processId)?.turns.get(turnId)?.definition;
		},
		getProcessGraph(processId) {
			return processDefs.get(processId);
		},
		getProcessDisplayName(processId) {
			return processDefs.get(processId)?.displayName;
		},
		resolveContextData(processId, process) {
			return resolveProcessContextData(processDefs.get(processId), process);
		},
		resolveTurnScopedAction(processId, process, actionId, source) {
			return resolveTurnScopedActionForProcess(
				processDefs.get(processId),
				process,
				actionId,
				source,
			);
		},
		resolveActionPreview(processId, process, actionId) {
			return resolveActionPreviewForProcess(
				processDefs.get(processId),
				process,
				serverDefs.get(processId)?.actions.get(actionId),
				actionId,
			);
		},
		resolveActionScheduling(processId, process, actionId) {
			const action = serverDefs.get(processId)?.actions.get(actionId);
			if (action?.executionMode === "side_effect") return null;
			const processDef = processDefs.get(processId);
			const visibleAction = resolveCurrentVisibleActionForProcess(processDef, process, actionId);
			return resolveActionTarget(
				visibleAction?.scheduling ?? action?.scheduling ?? null,
				processDef,
				process,
			);
		},
	};
}
