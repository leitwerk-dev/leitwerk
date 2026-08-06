import { type ProcessInstance, trimToNull } from "@leitwerk-dev/domain";
import { isHumanTurnDefinition } from "@leitwerk-dev/process-sdk";
import {
	createEphemeralWsFrame,
	WS_PROCESS_TYPES,
	type WsPayloadByType,
} from "@leitwerk-dev/protocol";
import type { ProcessSelectedTurnSummary } from "@leitwerk-dev/protocol/http-contracts";
import type { RepositoryBundle } from "./db/repositories.js";
import type {
	ProcessActionRegistry,
	VisibleProcessActionSummary,
} from "./process-action-registry.js";
import type { ProcessGraphRegistry } from "./process-graph.js";
import type { Broadcaster } from "./ws/broadcast.js";

export interface ProcessOperatorAttentionDeps
	extends Pick<RepositoryBundle, "projects" | "futureExecutions" | "turnRecords" | "turnStarts"> {
	processGraphs: ProcessGraphRegistry;
	processActionRegistry?: ProcessActionRegistry;
}

export interface AttentionToastBroadcastDeps extends ProcessOperatorAttentionDeps {
	broadcaster: Broadcaster;
	toastTtlMs?: number;
}

export type AttentionToastKind = "action_required" | "error";

type ProcessToastFramePayload = WsPayloadByType[typeof WS_PROCESS_TYPES.TOAST];

export function getProcessDisplayName(
	deps: Pick<ProcessOperatorAttentionDeps, "processActionRegistry">,
	processId: string,
): string | null {
	return deps.processActionRegistry?.getProcessDisplayName(processId) ?? null;
}

export function listCurrentVisibleActions(
	deps: ProcessOperatorAttentionDeps,
	process: ProcessInstance,
): VisibleProcessActionSummary[] {
	if (!deps.processActionRegistry) {
		return [];
	}
	const projects = deps.projects.listByInstance(process.id);
	const { params, state } = deps.processActionRegistry.resolveContextData(
		process.processId,
		process,
	);
	const ctx = {
		process,
		projects,
		params,
		state,
		async transition() {},
		emitEvent() {},
		readSemanticTurnResultMarkdown() {
			return null;
		},
		readProductTurnResultMarkdown() {
			return null;
		},
		queueInput() {},
	};
	return deps.processActionRegistry.listVisibleActions(process.processId, ctx);
}

export function listVisibleActionsForProcess(
	deps: ProcessOperatorAttentionDeps,
	process: ProcessInstance,
): VisibleProcessActionSummary[] {
	if (!deps.processActionRegistry) {
		return [];
	}
	if (
		process.lifecycleStatus !== "waiting" ||
		deps.futureExecutions.getScheduledActionByInstance(process.id)
	) {
		return [];
	}
	return listCurrentVisibleActions(deps, process);
}

export function getSelectedTurnSummaryForProcess(
	deps: Pick<ProcessOperatorAttentionDeps, "processActionRegistry">,
	process: ProcessInstance,
): ProcessSelectedTurnSummary | null {
	if (!deps.processActionRegistry) {
		return null;
	}
	return deps.processActionRegistry.getSelectedTurnSummary(process.processId, process);
}

function getSelectedTurnDescription(
	deps: Pick<ProcessOperatorAttentionDeps, "processActionRegistry">,
	process: ProcessInstance,
): string {
	const selectedTurnSummary = getSelectedTurnSummaryForProcess(deps, process);
	if (selectedTurnSummary?.description) {
		return selectedTurnSummary.description;
	}
	const selectedTurnId = trimToNull(process.selectedTurnId);
	if (
		selectedTurnId &&
		deps.processActionRegistry?.getTurnDefinition(process.processId, selectedTurnId)?.description
	) {
		return (
			deps.processActionRegistry.getTurnDefinition(process.processId, selectedTurnId)
				?.description ?? selectedTurnId
		);
	}
	return selectedTurnId ?? "Current step";
}

function getProcessAttentionLabel(
	deps: ProcessOperatorAttentionDeps,
	process: ProcessInstance,
): string {
	return (
		trimToNull(process.title) ??
		trimToNull(process.externalId) ??
		trimToNull(getProcessDisplayName(deps, process.processId)) ??
		process.processId
	);
}

function selectedTurnRequiresActionAttention(
	deps: ProcessOperatorAttentionDeps,
	process: ProcessInstance,
): boolean {
	if (!process.selectedTurnId) {
		return true;
	}
	const turnDef = deps.processActionRegistry?.getTurnDefinition(
		process.processId,
		process.selectedTurnId,
	);
	return !turnDef || !isHumanTurnDefinition(turnDef) || turnDef.operatorAttention !== "passive";
}

function buildActionRequiredToast(
	deps: ProcessOperatorAttentionDeps,
	process: ProcessInstance,
): Omit<ProcessToastFramePayload, "instanceId" | "ttlMs"> | null {
	if (process.lifecycleStatus !== "waiting") {
		return null;
	}
	if (!selectedTurnRequiresActionAttention(deps, process)) {
		return null;
	}
	const actions = listVisibleActionsForProcess(deps, process);
	if (actions.length === 0) {
		return null;
	}
	const processLabel = getProcessAttentionLabel(deps, process);
	const turnDescription = getSelectedTurnDescription(deps, process);
	return {
		level: "warn",
		eventType: "action_required",
		message: `${processLabel} · ${turnDescription} needs a decision`,
		dedupeKey: `${process.id}:action_required:${process.selectedTurnId ?? "none"}`,
	};
}

function buildErrorAttentionToast(
	deps: ProcessOperatorAttentionDeps,
	process: ProcessInstance,
	input: { errorCode?: string | null } = {},
): Omit<ProcessToastFramePayload, "instanceId" | "ttlMs"> | null {
	if (process.lifecycleStatus !== "error") {
		return null;
	}
	const processLabel = getProcessAttentionLabel(deps, process);
	const turnDescription = getSelectedTurnDescription(deps, process);
	const currentTurnRecordId = (() => {
		if (process.currentExecution?.kind === "server_turn") {
			return process.currentExecution.id;
		}
		if (process.currentExecution?.kind !== "worker_start") {
			return null;
		}
		const start = deps.turnStarts.getById(process.currentExecution.id);
		return start?.state.kind === "accepted" ? start.state.turnRecordId : null;
	})();
	const failedTurnRecord = currentTurnRecordId
		? deps.turnRecords.getById(currentTurnRecordId)
		: null;
	if (failedTurnRecord?.instanceId === process.id && failedTurnRecord.status === "failed") {
		return {
			level: "error",
			eventType: "turn_failed",
			message: `${processLabel} · ${turnDescription} failed and needs recovery`,
			dedupeKey: `${process.id}:turn_failed:${failedTurnRecord.id}`,
		};
	}
	return {
		level: "error",
		eventType: "worker_failed",
		message: `${processLabel} · ${turnDescription} needs attention`,
		dedupeKey: `${process.id}:worker_failed:${process.selectedTurnId ?? "none"}:${input.errorCode ?? "unknown"}`,
	};
}

export function buildProcessAttentionToast(
	deps: ProcessOperatorAttentionDeps,
	input: {
		process: ProcessInstance;
		kind: AttentionToastKind;
		errorCode?: string | null;
	},
): Omit<ProcessToastFramePayload, "instanceId" | "ttlMs"> | null {
	if (input.kind === "action_required") {
		return buildActionRequiredToast(deps, input.process);
	}
	return buildErrorAttentionToast(deps, input.process, { errorCode: input.errorCode });
}

export function broadcastProcessAttentionToast(
	deps: AttentionToastBroadcastDeps,
	input: {
		process: ProcessInstance;
		kind: AttentionToastKind;
		errorCode?: string | null;
	},
): boolean {
	const toast = buildProcessAttentionToast(deps, input);
	if (!toast) {
		return false;
	}
	const payload: ProcessToastFramePayload = {
		instanceId: input.process.id,
		...toast,
		ttlMs: deps.toastTtlMs ?? 6_000,
	};
	deps.broadcaster.broadcast(
		createEphemeralWsFrame({
			type: WS_PROCESS_TYPES.TOAST,
			payload,
			instanceId: input.process.id,
		}),
	);
	return true;
}
