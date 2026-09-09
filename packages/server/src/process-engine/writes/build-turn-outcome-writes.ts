import type { ProcessInstance, ProcessProject, TurnOutcomePayload } from "@leitwerk-dev/domain";
import {
	checkTurnOutcomeAvailability,
	validateTurnOutcome,
} from "../../domain-logic/outcome-tools.js";
import { findOutcomeTransition } from "../../domain-logic/process-state-machine.js";
import type { ProcessActionRegistry } from "../../process-action-registry.js";
import type { ProcessGraphRegistry } from "../../process-graph.js";
import { validateQueuedProcessInput } from "../../process-input-dispatch.js";
import type { TurnRecordMarkdownLookup } from "../../turn-result-markdown.js";
import { buildServerTransitionWrites } from "./build-server-transition-writes.js";
import { buildTurnSelectionWrites } from "./build-turn-selection-writes.js";
import { createDeferredExtensionEvent } from "./deferred-extension-events.js";
import { appendProcessEffects } from "./process-effects.js";
import { createProcessPlanCollector } from "./process-plan-collector.js";
import {
	appendProcessEvent,
	applyProcessPatchField,
	createWrites,
	isWriteBuildFailure,
	mergeWrites,
	type WriteBuildResult,
	type Writes,
} from "./writes.js";

function hasExplicitTurnSelectionChange(process: ProcessInstance, writes: Writes): boolean {
	return (
		writes.processPatch.selectedTurnId !== undefined &&
		writes.processPatch.selectedTurnId !== process.selectedTurnId
	);
}

async function buildProcessTurnOutcomeEffectWrites(
	processGraphs: ProcessGraphRegistry,
	process: ProcessInstance,
	projects: readonly ProcessProject[],
	payload: TurnOutcomePayload,
	processActionRegistry: ProcessActionRegistry,
	turnRecords: TurnRecordMarkdownLookup,
): Promise<WriteBuildResult> {
	const serverDef = processActionRegistry.getServerDefinition(process.processId);
	const handlers = serverDef?.turnOutcomeHandlers.get(payload.turnId) ?? [];

	const { params, state } = processActionRegistry.resolveContextData(process.processId, process);
	const plan = createProcessPlanCollector({ process, projects, params, state, turnRecords });

	for (const handler of handlers) {
		await handler(
			{
				turnRecordId: payload.turnRecordId,
				turnId: payload.turnId,
				outcome: payload.outcome,
				params: payload.params ?? {},
				turnResultMarkdown: payload.turnResultMarkdown ?? null,
			},
			plan.context,
		);
	}

	for (const queuedInput of plan.queuedInputs) {
		const validationError = validateQueuedProcessInput(queuedInput);
		if (validationError) {
			return { ok: false, code: "invalid_process_state", message: validationError };
		}
	}

	const effectWrites = createWrites({ queuedInputs: plan.queuedInputs });
	const transitionRequest = plan.transitionRequest;
	const transitionWrites = transitionRequest
		? buildServerTransitionWrites(processGraphs, process, transitionRequest)
		: createWrites();
	if (isWriteBuildFailure(transitionWrites)) {
		return transitionWrites;
	}

	for (const effects of plan.lifecycleEffects) {
		appendProcessEffects(effectWrites, { ...process, ...effectWrites.processPatch }, effects);
	}
	for (const emitted of plan.emittedEvents) {
		effectWrites.events.push({
			instanceId: process.id,
			eventType: emitted.type,
			data: { ...emitted.payload },
		});
		effectWrites.extensionEvents.push(emitted);
	}

	return mergeWrites(effectWrites, transitionWrites);
}

export interface TurnOutcomePlanningInput {
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	payload: TurnOutcomePayload;
	turnRecords: TurnRecordMarkdownLookup;
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: ProcessActionRegistry;
}

export async function buildTurnOutcomeWrites(
	input: TurnOutcomePlanningInput,
): Promise<WriteBuildResult> {
	const knownProjectKeys = new Set(input.projects.map((project) => project.key));
	const turnDefinition = input.processActionRegistry.getTurnDefinition(
		input.process.processId,
		input.payload.turnId,
	);
	const availabilityError = checkTurnOutcomeAvailability(
		input.processGraphs,
		turnDefinition,
		input.payload.turnId,
		input.payload.outcome,
		input.process.processId,
		input.process.selectedTurnId,
	);
	if (availabilityError) {
		return availabilityError;
	}
	const validationError = validateTurnOutcome(input.payload, turnDefinition, knownProjectKeys);
	if (validationError) {
		return validationError;
	}

	const baseWrites = createWrites();
	appendProcessEvent(baseWrites, input.process, {
		eventType: "turn_outcome_recorded",
		level: "info",
		message: `Recorded turn outcome ${input.payload.turnId}.${input.payload.outcome}`,
		data: {
			turnRecordId: input.payload.turnRecordId,
			turnId: input.payload.turnId,
			outcome: input.payload.outcome,
			params: input.payload.params,
		},
	});

	if (input.payload.state !== undefined) {
		applyProcessPatchField(
			baseWrites,
			{ stateJson: input.process.stateJson },
			"stateJson",
			JSON.stringify(input.payload.state),
		);
	}
	const processForEffects: ProcessInstance = { ...input.process, ...baseWrites.processPatch };

	const effectWrites = await buildProcessTurnOutcomeEffectWrites(
		input.processGraphs,
		processForEffects,
		input.projects,
		input.payload,
		input.processActionRegistry,
		input.turnRecords,
	);
	if (isWriteBuildFailure(effectWrites)) {
		return effectWrites;
	}

	let writes = mergeWrites(baseWrites, effectWrites);
	let candidateProcess: ProcessInstance = { ...input.process, ...writes.processPatch };

	if (
		candidateProcess.selectedTurnId === input.payload.turnId &&
		candidateProcess.lifecycleStatus === "active" &&
		!hasExplicitTurnSelectionChange(input.process, effectWrites)
	) {
		const outcomeTransition = findOutcomeTransition(
			input.processGraphs,
			candidateProcess.processId,
			input.payload.turnId,
			input.payload.outcome,
		);
		if (outcomeTransition) {
			const transitionWrites = buildTurnSelectionWrites(input.processGraphs, candidateProcess, {
				fromTurnId: candidateProcess.selectedTurnId,
				toTurnId: outcomeTransition.toTurnId,
				...(outcomeTransition.lifecycleStatus !== undefined
					? { lifecycleStatus: outcomeTransition.lifecycleStatus }
					: {}),
				state: undefined,
			});
			if (isWriteBuildFailure(transitionWrites)) {
				return transitionWrites;
			}
			writes = mergeWrites(writes, transitionWrites);
			candidateProcess = { ...candidateProcess, ...transitionWrites.processPatch };
		}
	}

	writes.extensionEvents.push(
		createDeferredExtensionEvent(input.process.id, "turn_outcome", {
			turnRecordId: input.payload.turnRecordId,
			turnId: input.payload.turnId,
			outcome: input.payload.outcome,
			params: input.payload.params ?? {},
			turnResultMarkdown: input.payload.turnResultMarkdown ?? null,
		}),
	);

	return writes;
}
