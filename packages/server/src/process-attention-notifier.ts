import type { EngineResult, ProcessEngineDeps } from "./process-engine/types.js";
import { broadcastProcessAttentionToast } from "./process-operator-attention.js";

function attentionDeps(deps: ProcessEngineDeps) {
	return {
		projects: deps.projects,
		futureExecutions: deps.futureExecutions,
		turnRecords: deps.turnRecords,
		turnStarts: deps.turnStarts,
		processGraphs: deps.processGraphs,
		processActionRegistry: deps.getProcessActionRegistry?.(),
		broadcaster: deps.broadcaster,
		toastTtlMs: deps.toastTtlMs,
	};
}

export function maybeBroadcastActionRequiredToast<T>(
	deps: ProcessEngineDeps,
	result: EngineResult<T>,
): EngineResult<T> {
	if (!result.process || !result.turnSelectionChange) {
		return result;
	}
	if (result.process.lifecycleStatus !== "waiting") {
		return result;
	}
	broadcastProcessAttentionToast(attentionDeps(deps), {
		process: result.process,
		kind: "action_required",
	});
	return result;
}

export function maybeBroadcastErrorAttentionToast<T>(
	deps: ProcessEngineDeps,
	result: EngineResult<T>,
	input: { errorCode?: string | null } = {},
): EngineResult<T> {
	if (!result.process) {
		return result;
	}
	if (result.process.lifecycleStatus !== "error") {
		return result;
	}
	broadcastProcessAttentionToast(attentionDeps(deps), {
		process: result.process,
		kind: "error",
		errorCode: input.errorCode,
	});
	return result;
}
