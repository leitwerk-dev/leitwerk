import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "../config/config-types.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import type { ScopedSettingsService } from "../scoped-settings-service.js";
import { constructPolicySnapshot, ProcessModelPolicyConfigurationError } from "./construct.js";
import { recoverPreparation, resolveTurn, validateSelection } from "./evaluate.js";
import { fingerprintPolicy } from "./fingerprint.js";
import {
	existingTurnSelectionFromProcess,
	modelConfigurationFromPersistedInput,
	modelConfigurationFromProcess,
	modelOverride,
} from "./input.js";
import { inspectPersistedModelIntegrity } from "./integrity.js";
import { prepareLaunchPlan } from "./launch.js";
import { projectPolicy } from "./project.js";
import type {
	PolicySnapshot,
	PrepareLaunchPlanOptions,
	ProcessModelPolicyEvaluation,
	ProcessModelPolicyEvaluationSubject,
	ProcessModelPolicyFingerprintSubject,
	ProcessModelPolicyProjectionByKind,
	ProcessModelPolicyProjectionKind,
	ProcessModelPolicyProjectionSubject,
	ProcessModelPolicyProjectionSubjectFor,
	ServerProcessModelPolicy,
} from "./types.js";

export type { StableAvailabilityEvaluation } from "./stable-availability.js";
export { evaluateAtStableAvailabilityRevision } from "./stable-availability.js";
export type {
	PersistedModelIntegrity,
	PersistedModelIntegrityIssue,
	PrepareLaunchPlanOptions,
	ProcessModelAvailabilitySnapshot,
	ProcessModelPolicyEvaluation,
	ProcessModelPolicyEvaluationSubject,
	ProcessModelPolicyFingerprintSubject,
	ProcessModelPolicyProjectionKind,
	ProcessModelPolicyProjectionSubject,
	ProcessModelPolicyProjectionSubjectFor,
	ProjectedLauncherModelPreview,
	ProjectedLauncherModelSchema,
	ProjectedModelDefault,
	ProjectedModelProfile,
	ProjectedModelResolutionSource,
	ProjectedProcessModelConfiguration,
	ServerProcessModelPolicy,
} from "./types.js";
export { ProcessModelPolicyConfigurationError };

function resolutionMode(
	startKind: Extract<ProcessModelPolicyEvaluationSubject, { kind: "process_turn" }>["startKind"],
	initialSelection: boolean | undefined,
): "resolve" | "initial" | "retry" | "continue" {
	if (startKind === "retry" || startKind === "startup_retry") return "retry";
	if (startKind === "continue") return "continue";
	if (initialSelection) return "initial";
	return "resolve";
}

function evaluateSubject(
	snapshot: PolicySnapshot,
	request: ProcessModelPolicyEvaluationSubject,
): ProcessModelPolicyEvaluation {
	if (request.kind === "process_turn") {
		return resolveTurn(
			snapshot,
			modelConfigurationFromProcess(request.process),
			request.turnId,
			resolutionMode(request.startKind, request.initialSelection),
			existingTurnSelectionFromProcess(request.process),
			modelOverride(
				request.modelOverride,
				Object.hasOwn(request, "modelOverride"),
				"action_override",
			),
			request.availability,
		);
	}
	if (request.kind === "launch_plan_turn") {
		const selected = request.plan.processInput.selectedTurnModelProfileId ?? null;
		return resolveTurn(
			snapshot,
			modelConfigurationFromPersistedInput({
				processId: request.plan.processId,
				defaultModelProfileId: request.plan.processInput.defaultModelProfileId,
				turnConfigsJson: request.plan.processInput.turnConfigsJson,
			}),
			request.turnId,
			"resolve",
			{ kind: "none" },
			modelOverride(selected, selected !== null, "launch_override"),
			request.availability,
		);
	}
	if (request.kind === "runtime_selection") {
		return validateSelection(snapshot, request.processId, request.selection, request.availability);
	}
	return recoverPreparation(
		snapshot,
		request.cause,
		modelConfigurationFromProcess(request.process),
		existingTurnSelectionFromProcess(request.process),
		request.currentStart,
		request.availability,
	);
}

/** Constructs the immutable, server-owned process model policy once at startup. */
export function createServerProcessModelPolicy(input: {
	config: LeitwerkConfig;
	processGraphs: ProcessGraphRegistry;
	processActionRegistry: Pick<ProcessActionRegistry, "getTurnDefinition">;
	scopedSettings?: Pick<ScopedSettingsService, "modelDefault">;
}): ServerProcessModelPolicy {
	const snapshot = constructPolicySnapshot(input);
	function scopedSnapshot(
		processId: string,
		process?: ProcessInstance,
		plan?: ProcessLaunchPlan,
	): PolicySnapshot {
		if (!input.scopedSettings) return snapshot;
		const policy = snapshot.processesById.get(processId);
		if (!policy) return snapshot;
		const processesById = new Map(snapshot.processesById);
		processesById.set(processId, {
			...policy,
			scopedProfileIdForTurn: (turnId) =>
				input.scopedSettings?.modelDefault(processId, turnId, process, plan) ?? null,
		});
		return { ...snapshot, processesById };
	}
	function projectionSnapshot(request: ProcessModelPolicyProjectionSubject): PolicySnapshot {
		return request.kind === "process_configuration"
			? scopedSnapshot(request.process.processId, request.process)
			: request.kind === "launcher_preview"
				? scopedSnapshot(request.processId, undefined, request.plan)
				: snapshot;
	}

	return Object.freeze({
		prepareLaunchPlan: (launchPlan: ProcessLaunchPlan, opts?: PrepareLaunchPlanOptions) =>
			prepareLaunchPlan(
				scopedSnapshot(launchPlan.processId, undefined, launchPlan),
				launchPlan,
				opts,
			),
		inspectPersistedState: (process: ProcessInstance) =>
			inspectPersistedModelIntegrity(snapshot, process),
		evaluate: (request: ProcessModelPolicyEvaluationSubject) =>
			evaluateSubject(
				request.kind === "process_turn" || request.kind === "preparation_recovery"
					? scopedSnapshot(request.process.processId, request.process)
					: request.kind === "launch_plan_turn"
						? scopedSnapshot(request.plan.processId, undefined, request.plan)
						: snapshot,
				request,
			),
		project: <K extends ProcessModelPolicyProjectionKind>(
			request: ProcessModelPolicyProjectionSubjectFor<K>,
		) =>
			projectPolicy(projectionSnapshot(request), request) as ProcessModelPolicyProjectionByKind[K],
		fingerprint: (request: ProcessModelPolicyFingerprintSubject) =>
			fingerprintPolicy(snapshot, request),
	});
}
