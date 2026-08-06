import type {
	InputKind,
	InputSource,
	ProcessInputTarget,
	ProcessInstance,
} from "@leitwerk-dev/domain";
import type {
	ProcessActionDefinition,
	ProcessLifecycleEffects,
	ServerProcessContext,
	ServerTransitionRequest,
} from "@leitwerk-dev/process-sdk";
import type { ProcessGraphRegistry } from "../../process-graph.js";
import { validateQueuedProcessInput } from "../../process-input-dispatch.js";
import { resolveProductTurnResultMarkdown } from "../../product-turn-result-markdown.js";
import {
	resolveSemanticTurnResultMarkdown,
	type TurnRecordMarkdownLookup,
} from "../../semantic-turn-result-markdown.js";
import { buildServerTransitionWrites } from "./build-server-transition-writes.js";
import {
	createDeferredExtensionEvent,
	type DeferredProcessExtensionEvent,
} from "./deferred-extension-events.js";
import { appendProcessEffects } from "./process-effects.js";
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

async function collectProcessActionPlanWithExecutor<TParams = unknown, TState = unknown>(input: {
	planning: ProcessActionPlanningInput<TParams, TState>;
	execute: (
		input: Record<string, unknown>,
		ctx: ServerProcessContext<TParams, TState>,
	) => Promise<void>;
}): Promise<ProcessActionPlanningResult> {
	const queuedInputs: Array<{
		source: InputSource;
		kind: InputKind;
		target?: ProcessInputTarget | null;
		bodyMarkdown: string;
	}> = [];
	const emittedEvents: DeferredProcessExtensionEvent[] = [];
	const lifecycleEffects: ProcessLifecycleEffects[] = [];
	let transitionRequest: ServerTransitionRequest<TState> | null = null;

	const ctx: ServerProcessContext<TParams, TState> = {
		process: input.planning.process,
		projects: input.planning.projects,
		params: input.planning.params,
		state: input.planning.state,
		async transition(next: ServerTransitionRequest<TState>) {
			transitionRequest = next;
		},
		emitEvent(
			eventType: Parameters<ServerProcessContext<TParams, TState>["emitEvent"]>[0],
			data: Parameters<ServerProcessContext<TParams, TState>["emitEvent"]>[1],
		) {
			emittedEvents.push(createDeferredExtensionEvent(input.planning.process.id, eventType, data));
		},
		readSemanticTurnResultMarkdown(ref) {
			return resolveSemanticTurnResultMarkdown({
				process: input.planning.process,
				semanticEntryRefKey: ref,
				turnRecords: input.planning.turnRecords,
				required: false,
			});
		},
		readProductTurnResultMarkdown(productName) {
			return resolveProductTurnResultMarkdown({
				process: input.planning.process,
				productName,
				turnRecords: input.planning.turnRecords,
				required: false,
			});
		},
		queueInput(queued) {
			queuedInputs.push({
				source: queued.source as InputSource,
				kind: queued.kind as InputKind,
				target: queued.target ?? null,
				bodyMarkdown: queued.bodyMarkdown,
			});
		},
		applyLifecycleEffects(effects) {
			lifecycleEffects.push(effects);
		},
	};

	if (!input.planning.isVisible) {
		return {
			ok: false,
			code: "action_not_visible",
			error: `Action '${input.planning.action.id}' is not available in the current state`,
		};
	}

	try {
		await input.execute(input.planning.input, ctx);
	} catch (error) {
		return {
			ok: false,
			code: "action_failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	for (const queuedInput of queuedInputs) {
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
		queuedInputs,
		extensionEvents: emittedEvents,
	});
	for (const effects of lifecycleEffects) {
		appendProcessEffects(
			baseWrites,
			{ ...input.planning.process, ...baseWrites.processPatch },
			effects,
		);
	}

	const transitionWrites = transitionRequest
		? buildServerTransitionWrites(
				input.planning.processGraphs,
				input.planning.process,
				transitionRequest,
			)
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

function resolveActionExecutor<TParams = unknown, TState = unknown>(input: {
	action: ProcessActionDefinition<TParams, TState>;
	requirePurePlan: boolean;
}):
	| ((input: Record<string, unknown>, ctx: ServerProcessContext<TParams, TState>) => Promise<void>)
	| null {
	if (input.action.plan) {
		return input.action.plan;
	}
	if (
		!input.requirePurePlan &&
		input.action.executionMode === "side_effect" &&
		input.action.execute
	) {
		return input.action.execute;
	}
	return null;
}

async function collectResolvedProcessActionPlan<TParams = unknown, TState = unknown>(input: {
	planning: ProcessActionPlanningInput<TParams, TState>;
	requirePurePlan: boolean;
}): Promise<ProcessActionPlanningResult> {
	const execute = resolveActionExecutor({
		action: input.planning.action,
		requirePurePlan: input.requirePurePlan,
	});
	if (!execute) {
		return {
			ok: false,
			code: "action_failed",
			error: input.requirePurePlan
				? `Action '${input.planning.action.id}' does not declare a pure plan(...) hook`
				: `Action '${input.planning.action.id}' does not declare plan(...) or side-effect execute(...)`,
		};
	}
	return collectProcessActionPlanWithExecutor({
		planning: input.planning,
		execute,
	});
}

export async function collectProcessActionPlan<TParams = unknown, TState = unknown>(
	input: ProcessActionPlanningInput<TParams, TState>,
): Promise<ProcessActionPlanningResult> {
	return collectResolvedProcessActionPlan({
		planning: input,
		requirePurePlan: false,
	});
}

export async function collectPureProcessActionPlan<TParams = unknown, TState = unknown>(
	input: ProcessActionPlanningInput<TParams, TState>,
): Promise<ProcessActionPlanningResult> {
	return collectResolvedProcessActionPlan({
		planning: input,
		requirePurePlan: true,
	});
}
