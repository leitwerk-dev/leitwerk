import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { ProcessActionDefinition, ServerProcessContext } from "@leitwerk-dev/process-sdk";
import type { ProcessGraphRegistry } from "../../process-graph.js";
import { validateQueuedProcessInput } from "../../process-input-dispatch.js";
import type { TurnRecordMarkdownLookup } from "../../turn-result-markdown.js";
import { buildServerTransitionWrites } from "./build-server-transition-writes.js";
import { appendProcessEffects } from "./process-effects.js";
import { createProcessPlanCollector } from "./process-plan-collector.js";
import { createWrites, isWriteBuildFailure, mergeWrites, type Writes } from "./writes.js";

export interface ProcessActionPlanningFailure {
	ok: false;
	code: "action_not_visible" | "action_failed";
	error: string;
}

export type ProcessActionPlanningResult = Writes | ProcessActionPlanningFailure;

export interface ProcessActionPlanningInput<TParams = unknown, TState = unknown> {
	process: ProcessInstance;
	projects: ServerProcessContext<TParams, TState>["projects"];
	params: TParams;
	state: TState;
	turnRecords: TurnRecordMarkdownLookup;
	processGraphs: ProcessGraphRegistry;
	action: ProcessActionDefinition<TParams, TState>;
	input: Record<string, unknown>;
	isVisible: boolean;
}

async function collectActionPlan<TParams, TState>(
	input: ProcessActionPlanningInput<TParams, TState>,
	requirePurePlan: boolean,
): Promise<ProcessActionPlanningResult> {
	const action = input.action;
	const execute =
		action.plan ??
		(!requirePurePlan && action.executionMode === "side_effect" ? action.execute : undefined);
	if (!execute) {
		return {
			ok: false,
			code: "action_failed",
			error: requirePurePlan
				? `Action '${action.id}' does not declare a pure plan(...) hook`
				: `Action '${action.id}' does not declare plan(...) or side-effect execute(...)`,
		};
	}
	if (!input.isVisible) {
		return {
			ok: false,
			code: "action_not_visible",
			error: `Action '${input.action.id}' is not available in the current state`,
		};
	}

	const plan = createProcessPlanCollector(input);
	try {
		await execute(input.input, plan.context);
	} catch (error) {
		return {
			ok: false,
			code: "action_failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	for (const queuedInput of plan.queuedInputs) {
		const validationError = validateQueuedProcessInput(queuedInput);
		if (validationError) {
			return {
				ok: false,
				code: "action_failed",
				error: validationError,
			};
		}
	}

	const baseWrites = createWrites({
		queuedInputs: plan.queuedInputs,
		extensionEvents: plan.emittedEvents,
	});
	for (const effects of plan.lifecycleEffects) {
		appendProcessEffects(baseWrites, { ...input.process, ...baseWrites.processPatch }, effects);
	}

	const transitionRequest = plan.transitionRequest;
	const transitionWrites = transitionRequest
		? buildServerTransitionWrites(input.processGraphs, input.process, transitionRequest)
		: createWrites();
	if (isWriteBuildFailure(transitionWrites)) {
		return {
			ok: false,
			code: "action_failed",
			error: transitionWrites.message,
		};
	}

	return mergeWrites(baseWrites, transitionWrites);
}

export function collectProcessActionPlan<TParams = unknown, TState = unknown>(
	input: ProcessActionPlanningInput<TParams, TState>,
): Promise<ProcessActionPlanningResult> {
	return collectActionPlan(input, false);
}

export function collectPureProcessActionPlan<TParams = unknown, TState = unknown>(
	input: ProcessActionPlanningInput<TParams, TState>,
): Promise<ProcessActionPlanningResult> {
	return collectActionPlan(input, true);
}
