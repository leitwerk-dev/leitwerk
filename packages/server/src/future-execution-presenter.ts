import type { FutureExecution, ProcessInstance } from "@leitwerk-dev/domain";
import type { FormDefinition, ProcessLauncherService } from "@leitwerk-dev/process-sdk";
import { parseFutureActionPayloadJson, parseFutureLaunchPayloadJson } from "@leitwerk-dev/protocol";
import type {
	FutureActionSummary,
	FutureExecutionSummary,
	FutureLaunchSummary,
	ProcessActionSummary as HttpProcessActionSummary,
	ScheduledActionDetail,
} from "@leitwerk-dev/protocol/http-contracts";
import type { RepositoryBundle } from "./db/repositories.js";
import type { ProcessActionRegistry } from "./process-action-registry.js";

export interface FutureExecutionPresenterDeps
	extends Pick<RepositoryBundle, "futureExecutions" | "processes"> {
	launcherService: ProcessLauncherService;
	processActionRegistry?: ProcessActionRegistry;
}

export interface BuildScheduledActionSummaryDeps extends FutureExecutionPresenterDeps {
	buildActionSummaryForProcess: (
		process: ProcessInstance,
		actionId: string,
		action: { id: string; label: string; form?: FormDefinition },
		labelOverride?: string | null,
		overrides?: { supportsScheduling?: boolean },
	) => HttpProcessActionSummary;
}

function futureSummaryState(execution: FutureExecution) {
	return {
		id: execution.id,
		nextRunAt: execution.nextRunAt,
		status: execution.blockedReason ? ("blocked" as const) : ("scheduled" as const),
		modelSelection: execution.modelSelection ?? null,
		blockedReason: execution.blockedReason ?? null,
	};
}

function futureActionLabel(label: string | null, fallback: string): string {
	return typeof label === "string" && label.trim() !== "" ? label : fallback;
}

export function buildFutureExecutionListView(
	deps: FutureExecutionPresenterDeps,
	execution: FutureExecution,
): FutureLaunchSummary | FutureActionSummary | null {
	const summary = {
		...futureSummaryState(execution),
		scheduleKind: execution.scheduleKind,
		processId: execution.processId,
		cronExpression: execution.cronExpression,
	};
	if (execution.kind === "launch") {
		const launcher = deps.launcherService
			.listUiLaunchers()
			.find((candidate) => candidate.id === execution.launcherId);
		const parsedPayload = parseFutureLaunchPayloadJson(execution.payloadJson);
		if (!parsedPayload.ok) {
			const launcherLabel = launcher?.label ?? execution.launcherId ?? execution.processId;
			return {
				...summary,
				kind: "launch",
				title: launcher?.card.title ?? launcherLabel,
				subtitle: `${launcherLabel} · invalid scheduled start`,
				launcherId: execution.launcherId ?? execution.processId,
				launcherLabel,
				launchTitle: null,
				launcherInput: {},
				skillIds: [],
				modelConfig: {},
			};
		}
		const payload = parsedPayload.value;
		const title =
			typeof payload.launchPlan.processInput.title === "string" &&
			payload.launchPlan.processInput.title.trim() !== ""
				? payload.launchPlan.processInput.title
				: typeof payload.launchPlan.processInput.externalId === "string" &&
						payload.launchPlan.processInput.externalId.trim() !== ""
					? payload.launchPlan.processInput.externalId
					: (launcher?.card.title ?? launcher?.label ?? payload.launchPlan.processId);
		const subtitle =
			execution.scheduleKind === "cron"
				? `${launcher?.label ?? payload.launchPlan.processId} · recurring cron`
				: `${launcher?.label ?? payload.launchPlan.processId} · scheduled start`;
		return {
			...summary,
			kind: "launch",
			title,
			subtitle,
			launcherId: execution.launcherId ?? payload.launchPlan.launcherId,
			launcherLabel: launcher?.label ?? payload.launchPlan.launcherId,
			launchTitle: payload.launchPlan.processInput.title,
			launcherInput: payload.launcherInput,
			skillIds: [...payload.selectedSkillIds],
			modelConfig: payload.modelConfig,
		};
	}
	if (!execution.instanceId || !execution.actionId) {
		return null;
	}
	const process = deps.processes.getById(execution.instanceId);
	const parsedPayload = parseFutureActionPayloadJson(execution.payloadJson);
	const payload = parsedPayload.ok ? parsedPayload.value : null;
	const actionLabel = futureActionLabel(payload?.actionLabel ?? null, execution.actionId);
	return {
		...summary,
		kind: "action",
		title: process?.title ?? process?.externalId ?? actionLabel,
		subtitle: `${actionLabel} · ${payload ? "scheduled action" : "invalid scheduled action"}`,
		instanceId: execution.instanceId,
		actionId: execution.actionId,
		actionLabel,
		nextTurnModelProfileId: payload?.nextTurnModelProfileId ?? null,
	};
}

export function buildFutureExecutionSummaries(
	deps: FutureExecutionPresenterDeps,
	executions: readonly FutureExecution[],
): FutureExecutionSummary[] {
	return executions
		.map((execution) => buildFutureExecutionListView(deps, execution))
		.filter((execution): execution is FutureExecutionSummary => execution !== null);
}

export function getScheduledActionDetailForProcess(
	deps: BuildScheduledActionSummaryDeps,
	process: ProcessInstance,
): ScheduledActionDetail | null {
	if (!deps.processActionRegistry) {
		return null;
	}
	const scheduledAction = deps.futureExecutions.getScheduledActionByInstance(process.id);
	if (!scheduledAction?.actionId) {
		return null;
	}
	const action = deps.processActionRegistry.getAction(process.processId, scheduledAction.actionId);
	if (!action) {
		return null;
	}
	const parsedPayload = parseFutureActionPayloadJson(scheduledAction.payloadJson);
	if (!parsedPayload.ok) {
		return null;
	}
	const payload = parsedPayload.value;
	const actionLabel = futureActionLabel(payload.actionLabel, action.label);
	return {
		...futureSummaryState(scheduledAction),
		actionId: scheduledAction.actionId,
		actionLabel,
		input: payload.input,
		nextTurnModelProfileId: payload.nextTurnModelProfileId,
		action: deps.buildActionSummaryForProcess(
			process,
			scheduledAction.actionId,
			action,
			actionLabel,
			{ supportsScheduling: true },
		),
	};
}
