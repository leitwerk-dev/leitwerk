import type { Actor } from "@leitwerk-dev/domain";
import { canAbort } from "../../domain-logic/process-state-machine.js";
import { planCancelScheduledAction } from "../../future-execution/transition-planner.js";
import { buildAbortProcessWrites } from "../../process-engine/writes/build-process-abort-writes.js";
import { appendProcessEffects } from "../../process-engine/writes/process-effects.js";
import {
	applyProcessPatchField,
	createWrites,
	isWriteBuildFailure,
	mergeWrites,
	stampActorOnEvents,
	type Writes,
} from "../../process-engine/writes/writes.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import type { DecideContext } from "../types.js";

export interface AbortProcessInput {
	instanceId: string;
	actor?: Actor;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function collectAbortCleanupWrites(
	ctx: DecideContext,
	input: AbortProcessInput,
): Promise<Writes> {
	const registry = ctx.deps.getProcessActionRegistry?.();
	const serverDef = registry?.getServerDefinition(ctx.process.processId);
	const cleanupHandlers = serverDef?.cleanupHandlers ?? [];
	if (!registry || cleanupHandlers.length === 0) {
		return createWrites();
	}

	const contextData = registry.resolveContextData(ctx.process.processId, ctx.process);
	const projects = ctx.deps.projects.listByInstance(input.instanceId);
	const writes = createWrites();
	let currentProcess = ctx.process;
	let currentState = contextData.state;

	for (const handler of cleanupHandlers) {
		const result = await handler({
			process: currentProcess,
			projects,
			params: contextData.params,
			state: currentState,
			reason: "abort",
		});
		if (!result) {
			continue;
		}
		appendProcessEffects(writes, currentProcess, result);
		currentProcess = { ...currentProcess, ...writes.processPatch };
		if (result.state !== undefined) {
			const nextStateJson = JSON.stringify(result.state);
			applyProcessPatchField(writes, currentProcess, "stateJson", nextStateJson);
			currentProcess = { ...currentProcess, stateJson: nextStateJson };
			currentState = result.state;
		}
	}

	return writes;
}

export const AbortProcess = defineOperation<"abort_process", AbortProcessInput, void>({
	kind: "abort_process",
	label: "Abort process",
	async decide(ctx, input) {
		if (!canAbort(ctx.process.lifecycleStatus)) {
			return reject(
				"invalid_transition",
				"Process cannot be aborted in the current lifecycle status",
			);
		}
		const activeTurnRecordId =
			ctx.process.currentExecution?.kind === "worker_start"
				? (() => {
						const start = ctx.deps.turnStarts.getById(ctx.process.currentExecution.id);
						return start?.state.kind === "accepted" ? start.state.turnRecordId : null;
					})()
				: null;
		const activeTurnRecord = activeTurnRecordId
			? ctx.deps.turnRecords.getById(activeTurnRecordId)
			: null;
		const currentWorkerStart =
			ctx.process.currentExecution?.kind === "worker_start"
				? ctx.deps.turnStarts.getById(ctx.process.currentExecution.id)
				: null;
		let cleanupWrites: Writes;
		try {
			cleanupWrites = await collectAbortCleanupWrites(ctx, input);
		} catch (error) {
			return reject("process_cleanup_failed", toErrorMessage(error));
		}
		const processAfterCleanup = { ...ctx.process, ...cleanupWrites.processPatch };
		const abortWrites = buildAbortProcessWrites({
			processGraphs: ctx.deps.processGraphs,
			process: processAfterCleanup,
			activeTurnRecord,
			currentWorkerStart,
		});
		if (isWriteBuildFailure(abortWrites)) {
			return abortWrites;
		}
		const writes = mergeWrites(cleanupWrites, abortWrites);
		stampActorOnEvents(writes, input.actor, "turn_selected");
		stampActorOnEvents(writes, input.actor, "process_aborted");
		for (const execution of ctx.deps.futureExecutions.listByInstance(input.instanceId)) {
			const plan = planCancelScheduledAction(execution, input.instanceId);
			if (!plan) continue;
			writes.futureExecutionPlans.push(plan);
			writes.broadcasts.push({
				type: "future.updated",
				payload: {
					futureExecutionId: execution.id,
					operation: "deleted",
					kind: execution.kind,
				},
				instanceId: input.instanceId,
			});
		}
		return accept({ writes });
	},
});
