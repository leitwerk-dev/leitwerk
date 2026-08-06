import type {
	ProcessInstance,
	ProcessSemanticEntryRefKey,
	ProcessTurnTerminalLifecycleStatus,
	ProcessTurnTransition,
	ReviewSubject,
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
	getExternalSourceTransitionId,
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
	reviewSubject: ReviewSubject | null;
	semanticEntryRefKey: ProcessSemanticEntryRefKey | null;
	acceptanceState: TurnAcceptanceState;
}

export interface ResolvedExternalHumanTriggerAction {
	kind: "external_human_trigger";
	turnId: string;
	turnType: "external";
	reviewSubject: ReviewSubject | null;
	semanticEntryRefKey: ProcessSemanticEntryRefKey | null;
	acceptanceState: TurnAcceptanceState;
	externalTrigger: { id: string; actionId: string; label: string; description: string };
}

export type ResolvedTurnScopedAction =
	| ResolvedUiHumanTurnAction
	| ResolvedExternalHumanTriggerAction;

export interface ResolvedActionPreview {
	definition: ProcessActionPreviewDefinition;
	candidateSelectedTurnId: string | null;
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus | null;
}

export interface ResolvedActionScheduling {
	definition: ProcessActionSchedulingDefinition;
	candidateSelectedTurnId: string | null;
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus | null;
}

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
		process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
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

function getTurnReviewSemanticRef(
	turnDef: TurnDefinition<unknown, unknown>,
): ProcessSemanticEntryRefKey | null {
	return "reviewSemanticRef" in turnDef ? (turnDef.reviewSemanticRef ?? null) : null;
}

function getTurnReviewSubject(turnDef: TurnDefinition<unknown, unknown>): ReviewSubject | null {
	if (isHumanTurnDefinition(turnDef)) {
		return turnDef.reviewSubject ?? null;
	}
	if (isExternalTurnDefinition(turnDef)) {
		return turnDef.reviewSubject ?? null;
	}
	return turnDef.reviewSubject ?? null;
}

function getProcessTurnBinding(processDef: ExtensionProcessDefinition | undefined, turnId: string) {
	return processDef?.turns.get(turnId);
}

function resolveCurrentTurnForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
): { turnId: string; turnDef: TurnDefinition<unknown, unknown> } | null {
	if (!processDef || !process.selectedTurnId) {
		return null;
	}

	const selectedTurn = getProcessTurnBinding(processDef, process.selectedTurnId)?.definition;
	if (!selectedTurn) {
		return null;
	}

	const selectedTurnReviewSubject = getTurnReviewSubject(selectedTurn);
	if (!selectedTurnReviewSubject) {
		return { turnId: process.selectedTurnId, turnDef: selectedTurn };
	}

	const { state } = resolveProcessContextData(processDef, process);
	const currentReviewSubject =
		(state as { reviewSubject?: ReviewSubject | null }).reviewSubject ?? null;
	if (!currentReviewSubject || currentReviewSubject.kind === selectedTurnReviewSubject.kind) {
		return { turnId: process.selectedTurnId, turnDef: selectedTurn };
	}
	return null;
}

function listExternalTriggers(
	turnId: string,
	turnDef: TurnDefinition<unknown, unknown>,
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
			...view.externalActions.map((action) => ({
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
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
): ProcessSelectedTurnSummary | null {
	const currentTurn = resolveCurrentTurnForProcess(processDef, process);
	if (!currentTurn) {
		return null;
	}
	return {
		turnId: currentTurn.turnId,
		kind: currentTurn.turnDef.kind,
		description: currentTurn.turnDef.description,
		commentary: isHumanTurnDefinition(currentTurn.turnDef)
			? (currentTurn.turnDef.commentary ?? null)
			: null,
		externalTriggers: listExternalTriggers(currentTurn.turnId, currentTurn.turnDef),
	};
}

function resolvePreviewDefinitionForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
	action: ProcessActionDefinition | undefined,
	actionId: string,
): ProcessActionPreviewDefinition | null {
	const visibleAction = resolveCurrentVisibleActionForProcess(processDef, process, actionId);
	if (visibleAction?.preview) {
		return visibleAction.preview;
	}
	if (visibleAction?.scheduling?.preview) {
		return visibleAction.scheduling.preview;
	}
	if (action?.preview) {
		return action.preview;
	}
	return action?.scheduling?.preview ?? null;
}

function resolveSchedulingDefinitionForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
	action: ProcessActionDefinition | undefined,
	actionId: string,
): ProcessActionSchedulingDefinition | null {
	if (action?.executionMode === "side_effect") {
		return null;
	}
	const visibleAction = resolveCurrentVisibleActionForProcess(processDef, process, actionId);
	if (visibleAction?.scheduling) {
		return visibleAction.scheduling;
	}
	return action?.scheduling ?? null;
}

function resolveTransitionTarget(
	transition: Pick<ProcessTurnTransition, "nextTurnId" | "lifecycleStatus">,
): {
	candidateSelectedTurnId: string | null;
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus | null;
} {
	return {
		candidateSelectedTurnId: transition.nextTurnId ?? null,
		lifecycleStatus: transition.lifecycleStatus ?? null,
	};
}

function resolvePreviewTargetForProcess(
	preview: ProcessActionPreviewDefinition,
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
):
	| {
			candidateSelectedTurnId: string | null;
			lifecycleStatus: ProcessTurnTerminalLifecycleStatus | null;
	  }
	| undefined {
	if (preview.kind === "fixed_turn") {
		return {
			candidateSelectedTurnId: preview.turnId,
			lifecycleStatus: null,
		};
	}
	if (preview.kind === "terminal") {
		return {
			candidateSelectedTurnId: null,
			lifecycleStatus: preview.lifecycleStatus,
		};
	}
	if (!processDef || !process.selectedTurnId) {
		return undefined;
	}
	const transitions: readonly ProcessTurnTransition[] =
		toProcessGraphView(processDef).turns.get(process.selectedTurnId)?.transitions ?? [];
	const matchingTransitions = transitions.filter(
		(transition: ProcessTurnTransition) => transition.trigger === preview.trigger,
	);
	if (matchingTransitions.length !== 1) {
		return undefined;
	}
	const [transition] = matchingTransitions;
	if (!transition) {
		return undefined;
	}
	return resolveTransitionTarget(transition);
}

function resolveActionPreviewForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
	action: ProcessActionDefinition | undefined,
	actionId: string,
): ResolvedActionPreview | null {
	const definition = resolvePreviewDefinitionForProcess(processDef, process, action, actionId);
	if (!definition) {
		return null;
	}
	const target = resolvePreviewTargetForProcess(definition, processDef, process);
	if (!target) {
		return null;
	}
	return {
		definition,
		candidateSelectedTurnId: target.candidateSelectedTurnId,
		lifecycleStatus: target.lifecycleStatus,
	};
}

function resolveActionSchedulingForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
	action: ProcessActionDefinition | undefined,
	actionId: string,
): ResolvedActionScheduling | null {
	const definition = resolveSchedulingDefinitionForProcess(processDef, process, action, actionId);
	if (!definition) {
		return null;
	}
	const target = resolvePreviewTargetForProcess(definition.preview, processDef, process);
	if (!target) {
		return null;
	}
	return {
		definition,
		candidateSelectedTurnId: target.candidateSelectedTurnId,
		lifecycleStatus: target.lifecycleStatus,
	};
}

function resolveTurnScopedActionForProcess(
	processDef: ExtensionProcessDefinition | undefined,
	process: Pick<ProcessInstance, "selectedTurnId" | "paramsJson" | "stateJson">,
	actionId: string,
	source: ProcessActionExecutionSource,
): ResolvedTurnScopedAction | null {
	if (!processDef) {
		return null;
	}
	const currentTurn = resolveCurrentTurnForProcess(processDef, process);
	if (!currentTurn) {
		return null;
	}

	if (isHumanTurnDefinition(currentTurn.turnDef)) {
		const view = resolveHumanTurnView({
			turnId: currentTurn.turnId,
			turn: currentTurn.turnDef,
		});
		if (source !== "external") {
			const turnAction = view.actions.find((action) => action.actionId === actionId);
			if (!turnAction) {
				return null;
			}
			return {
				kind: "ui_human_action",
				turnId: currentTurn.turnId,
				turnType: "human",
				reviewSubject: currentTurn.turnDef.reviewSubject ?? null,
				semanticEntryRefKey: getTurnReviewSemanticRef(currentTurn.turnDef),
				acceptanceState: turnAction.acceptanceState,
			};
		}

		const externalTrigger = view.externalTriggers.find((trigger) => trigger.actionId === actionId);
		if (!externalTrigger) {
			return null;
		}
		const matchingVisibleAction = view.actions.find((action) => action.actionId === actionId);
		if (!matchingVisibleAction) {
			return null;
		}
		return {
			kind: "external_human_trigger",
			turnId: currentTurn.turnId,
			turnType: "external",
			reviewSubject: currentTurn.turnDef.reviewSubject ?? null,
			semanticEntryRefKey: getTurnReviewSemanticRef(currentTurn.turnDef),
			acceptanceState: matchingVisibleAction.acceptanceState,
			externalTrigger: {
				id: externalTrigger.id,
				actionId: externalTrigger.actionId,
				label: externalTrigger.label,
				description: externalTrigger.description,
			},
		};
	}

	return null;
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

		getSelectedTurnSummary(processId, process) {
			return buildSelectedTurnSummaryForProcess(processDefs.get(processId), process);
		},

		getServerDefinition(processId) {
			return serverDefs.get(processId);
		},
		getTurnDefinition(processId, turnId) {
			return getProcessTurnBinding(processDefs.get(processId), turnId)?.definition;
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
			return resolveActionSchedulingForProcess(
				processDefs.get(processId),
				process,
				serverDefs.get(processId)?.actions.get(actionId),
				actionId,
			);
		},
	};
}
