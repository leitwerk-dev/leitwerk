import { isDeepStrictEqual } from "node:util";
import type {
	DeferredProcessActivationFailure,
	DeferredProcessActivationOutcome,
	PreparedDeferredProcessActivation,
} from "@leitwerk-dev/process-sdk";
import { accept } from "../decision.js";
import { defineOperation } from "../operation.js";
import { buildTurnSelectionWrites } from "../writes/build-turn-selection-writes.js";
import {
	appendProcessEvent,
	applyProcessPatchField,
	createWrites,
	mergeWrites,
	stampActorOnEvents,
} from "../writes/writes.js";

function expectedFactsMatch(
	process: Parameters<typeof buildTurnSelectionWrites>[1],
	project: {
		id: string;
		key: string;
		repoLocator: string;
		baseBranch: string;
		workBranch: string | null;
	},
	expected: PreparedDeferredProcessActivation["expected"],
): boolean {
	return (
		process.processId === expected.processId &&
		process.lifecycleStatus === expected.lifecycleStatus &&
		process.selectedTurnId === expected.selectedTurnId &&
		process.title === expected.title &&
		process.paramsJson === expected.paramsJson &&
		project.id === expected.projectId &&
		project.key === expected.projectKey &&
		project.repoLocator === expected.repoLocator &&
		project.baseBranch === expected.baseBranch &&
		project.workBranch === expected.workBranch
	);
}

export interface ActivateDeferredProcessInput {
	instanceId: string;
	prepared: PreparedDeferredProcessActivation;
}

export const ActivateDeferredProcess = defineOperation<
	"activate_deferred_process",
	ActivateDeferredProcessInput,
	{ outcome: DeferredProcessActivationOutcome }
>({
	kind: "activate_deferred_process",
	label: "Activate deferred process",
	decide(ctx, input) {
		const { prepared } = input;
		const project = ctx.deps.projects.getByInstanceAndKey(
			ctx.instanceId,
			prepared.expected.projectKey,
		);
		if (!project || project.id !== prepared.expected.projectId) {
			return accept({ data: { outcome: "project_not_found" } });
		}

		const exactReplay =
			ctx.process.processId === prepared.expected.processId &&
			ctx.process.selectedTurnId === prepared.selectedTurnId &&
			ctx.process.paramsJson === prepared.paramsJson &&
			project.workBranch === prepared.workBranch &&
			isDeepStrictEqual(project.metadata, prepared.projectMetadata);
		if (exactReplay) {
			return accept({ data: { outcome: "already_activated" } });
		}

		if (
			ctx.process.processId !== prepared.expected.processId ||
			ctx.process.lifecycleStatus !== "discovered" ||
			ctx.process.selectedTurnId !== null ||
			(project.workBranch !== prepared.expected.workBranch &&
				project.workBranch !== prepared.workBranch)
		) {
			return accept({ data: { outcome: "not_applicable" } });
		}
		if (!expectedFactsMatch(ctx.process, project, prepared.expected)) {
			return accept({ data: { outcome: "stale" } });
		}

		const selection = buildTurnSelectionWrites(ctx.deps.processGraphs, ctx.process, {
			fromTurnId: null,
			toTurnId: prepared.selectedTurnId,
			trigger: "start",
		});
		if ("ok" in selection) {
			return accept({ data: { outcome: "invalid_selected_turn" } });
		}
		const activation = createWrites({
			processPatch: { paramsJson: prepared.paramsJson },
			changedFields: ctx.process.paramsJson === prepared.paramsJson ? [] : ["paramsJson"],
			projectWrite: {
				id: project.id,
				input: {
					workBranch: prepared.workBranch,
					metadata: prepared.projectMetadata,
				},
			},
		});
		appendProcessEvent(activation, ctx.process, prepared.event);
		const writes = mergeWrites(activation, selection);
		stampActorOnEvents(writes, prepared.actor, prepared.event.eventType);
		stampActorOnEvents(writes, prepared.actor, "turn_selected");
		return accept({ writes, data: { outcome: "activated" } });
	},
});

export interface ParkDeferredProcessActivationFailureInput {
	instanceId: string;
	failure: DeferredProcessActivationFailure;
}

export const ParkDeferredProcessActivationFailure = defineOperation<
	"park_deferred_process_activation_failure",
	ParkDeferredProcessActivationFailureInput,
	{ outcome: "parked" | "stale" | "not_applicable" | "project_not_found" }
>({
	kind: "park_deferred_process_activation_failure",
	label: "Park deferred process activation failure",
	decide(ctx, input) {
		const project = ctx.deps.projects.getByInstanceAndKey(
			ctx.instanceId,
			input.failure.expected.projectKey,
		);
		if (!project || project.id !== input.failure.expected.projectId) {
			return accept({ data: { outcome: "project_not_found" } });
		}
		if (
			ctx.process.lifecycleStatus !== "discovered" ||
			ctx.process.selectedTurnId !== null ||
			project.workBranch !== input.failure.expected.workBranch
		) {
			return accept({ data: { outcome: "not_applicable" } });
		}
		if (!expectedFactsMatch(ctx.process, project, input.failure.expected)) {
			return accept({ data: { outcome: "stale" } });
		}

		const writes = createWrites({
			workerIntent: {
				kind: "stop_with_reason",
				reason: `deferred_activation_failed:${input.failure.errorClass}`,
			},
		});
		applyProcessPatchField(writes, ctx.process, "lifecycleStatus", "error");
		appendProcessEvent(writes, ctx.process, input.failure.event);
		return accept({ writes, data: { outcome: "parked" } });
	},
});
