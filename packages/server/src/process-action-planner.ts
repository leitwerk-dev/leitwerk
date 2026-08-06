import type { ProcessInstance, ProcessProject } from "@leitwerk-dev/domain";
import type { ProcessActionExecutionSource } from "@leitwerk-dev/process-sdk";
import { validateProcessActionInput } from "./process-action-input-validation.js";
import type {
	ProcessActionRegistry,
	ResolvedTurnScopedAction,
	VisibleProcessActionSummary,
} from "./process-action-registry.js";
import {
	collectProcessActionPlan,
	collectPureProcessActionPlan,
} from "./process-engine/writes/build-process-action-writes.js";
import type { Writes } from "./process-engine/writes/writes.js";
import type { ProcessGraphRegistry } from "./process-graph.js";
import type { TurnRecordMarkdownLookup } from "./semantic-turn-result-markdown.js";

export interface PlannedProcessActionSuccess {
	ok: true;
	action: NonNullable<ReturnType<ProcessActionRegistry["getAction"]>>;
	actionLabel: string;
	visibleAction: VisibleProcessActionSummary | null;
	resolvedTurnAction: ResolvedTurnScopedAction | null;
	writes: Writes;
	candidateProcess: ProcessInstance;
	candidateSelectedTurnId: string | null;
}

export interface PlannedProcessActionFailure {
	ok: false;
	code: "action_not_found" | "action_not_visible" | "invalid_action_input" | "action_failed";
	error: string;
}

export type PlannedProcessActionResult = PlannedProcessActionSuccess | PlannedProcessActionFailure;

export async function planProcessAction(input: {
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: Pick<
		ProcessActionRegistry,
		| "getAction"
		| "isTurnScopedAction"
		| "listVisibleActions"
		| "resolveContextData"
		| "resolveTurnScopedAction"
	>;
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	turnRecords: TurnRecordMarkdownLookup;
	actionId: string;
	actionInput: Record<string, unknown>;
	actionSource?: ProcessActionExecutionSource;
	allowHiddenTurnScopedAction?: boolean;
	requirePurePlan?: boolean;
}): Promise<PlannedProcessActionResult> {
	const action = input.processActionRegistry.getAction(input.process.processId, input.actionId);
	if (!action) {
		return {
			ok: false,
			code: "action_not_found",
			error: `Action '${input.actionId}' not found`,
		};
	}

	const inputValidation = validateProcessActionInput(action, input.actionInput);
	if (inputValidation) {
		return inputValidation;
	}

	const contextData = input.processActionRegistry.resolveContextData(
		input.process.processId,
		input.process,
	);
	const visibleAction = input.processActionRegistry
		.listVisibleActions(input.process.processId, {
			process: input.process,
			projects: [...input.projects],
			params: contextData.params,
			state: contextData.state,
			async transition() {},
			emitEvent() {},
			readSemanticTurnResultMarkdown() {
				return null;
			},
			readProductTurnResultMarkdown() {
				return null;
			},
			queueInput() {},
		})
		.find((candidate) => candidate.id === input.actionId);
	const actionSource = input.actionSource ?? "ui";
	const resolvedTurnAction = input.processActionRegistry.resolveTurnScopedAction(
		input.process.processId,
		input.process,
		input.actionId,
		actionSource,
	);
	const isTurnScopedAction = input.processActionRegistry.isTurnScopedAction(
		input.process.processId,
		input.actionId,
	);
	const isVisible =
		actionSource === "external"
			? resolvedTurnAction !== null || !isTurnScopedAction
			: visibleAction !== undefined ||
				!isTurnScopedAction ||
				input.allowHiddenTurnScopedAction === true;
	if (!isVisible) {
		return {
			ok: false,
			code: "action_not_visible",
			error: `Action '${input.actionId}' is not available in the current state`,
		};
	}

	const planned = input.requirePurePlan
		? await collectPureProcessActionPlan({
				process: input.process,
				projects: input.projects,
				params: contextData.params,
				state: contextData.state,
				turnRecords: input.turnRecords,
				processGraphs: input.processGraphs,
				action,
				input: input.actionInput,
				isVisible: true,
			})
		: await collectProcessActionPlan({
				process: input.process,
				projects: input.projects,
				params: contextData.params,
				state: contextData.state,
				turnRecords: input.turnRecords,
				processGraphs: input.processGraphs,
				action,
				input: input.actionInput,
				isVisible: true,
			});
	if ("ok" in planned) {
		return planned;
	}

	const candidateProcess: ProcessInstance = {
		...input.process,
		...planned.processPatch,
	};
	const candidateSelectedTurnId =
		planned.processPatch.selectedTurnId !== undefined
			? planned.processPatch.selectedTurnId
			: input.process.selectedTurnId;
	return {
		ok: true,
		action,
		actionLabel: visibleAction?.label ?? action.label,
		visibleAction: visibleAction ?? null,
		resolvedTurnAction,
		writes: planned,
		candidateProcess,
		candidateSelectedTurnId,
	};
}
