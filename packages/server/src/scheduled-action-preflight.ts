import type { ProcessInstance, ProcessProject } from "@leitwerk-dev/domain";
import { isLlmTurnDefinition, type ProcessActionDefinition } from "@leitwerk-dev/process-sdk";
import { planProcessAction } from "./process-action-planner.js";
import type { ProcessActionRegistry, ResolvedActionScheduling } from "./process-action-registry.js";
import type { ProcessGraphRegistry } from "./process-graph.js";
import type { TurnRecordMarkdownLookup } from "./turn-result-markdown.js";

export interface ScheduledActionPreflightFailure {
	ok: false;
	code:
		| "action_not_found"
		| "action_not_visible"
		| "action_not_schedulable"
		| "invalid_action_input"
		| "action_failed";
	error: string;
}

export interface ScheduledActionPreflightSuccess {
	ok: true;
	action: ProcessActionDefinition;
	actionLabel: string;
	scheduling: ResolvedActionScheduling;
	candidateSelectedTurnId: string | null;
}

export type ScheduledActionPreflightResult =
	| ScheduledActionPreflightSuccess
	| ScheduledActionPreflightFailure;

export async function preflightScheduledActionRequest(input: {
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: ProcessActionRegistry;
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	turnRecords: TurnRecordMarkdownLookup;
	actionId: string;
	actionInput: Record<string, unknown>;
	nextTurnModelProfileId?: string | null;
}): Promise<ScheduledActionPreflightResult> {
	const action = input.processActionRegistry.getAction(input.process.processId, input.actionId);
	if (!action) {
		return {
			ok: false,
			code: "action_not_found",
			error: `Action '${input.actionId}' not found`,
		};
	}
	const scheduling = input.processActionRegistry.resolveActionScheduling(
		input.process.processId,
		input.process,
		input.actionId,
	);
	if (!scheduling || !action.plan) {
		return {
			ok: false,
			code: "action_not_schedulable",
			error: `Action '${input.actionId}' does not support scheduling`,
		};
	}
	const planned = await planProcessAction({
		processGraphs: input.processGraphs,
		processActionRegistry: input.processActionRegistry,
		process: input.process,
		projects: input.projects,
		turnRecords: input.turnRecords,
		actionId: input.actionId,
		actionInput: input.actionInput,
		requirePurePlan: true,
	});
	if (!planned.ok) {
		return planned;
	}
	if (input.nextTurnModelProfileId !== undefined) {
		const candidateTurnDef = planned.candidateSelectedTurnId
			? input.processActionRegistry.getTurnDefinition(
					input.process.processId,
					planned.candidateSelectedTurnId,
				)
			: undefined;
		if (!candidateTurnDef || !isLlmTurnDefinition(candidateTurnDef)) {
			return {
				ok: false,
				code: "action_failed",
				error: "Next-turn model override is only available when the action selects an LLM turn",
			};
		}
	}
	return {
		ok: true,
		action,
		actionLabel: planned.actionLabel,
		scheduling,
		candidateSelectedTurnId: planned.candidateSelectedTurnId,
	};
}
