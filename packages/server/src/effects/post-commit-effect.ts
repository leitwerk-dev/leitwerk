import type { FutureExecution, ProcessInput, ProcessLifecycleStatus } from "@leitwerk-dev/domain";
import type {
	ProcessLaunchPlan,
	ServerExtensionEventName,
	ServerExtensionEventPayloadInputMap,
} from "@leitwerk-dev/process-sdk";
import type { DurableWsFrameInput } from "@leitwerk-dev/protocol";
import {
	createDeferredExtensionEvent,
	type DeferredProcessExtensionEvent,
} from "../process-engine/writes/deferred-extension-events.js";
import type { WorkerIntent } from "../process-engine/writes/writes.js";

export interface WorkerReconcileEffectChange {
	fromTurnId: string | null;
	toTurnId: string | null;
	fromLifecycleStatus: ProcessLifecycleStatus;
	toLifecycleStatus: ProcessLifecycleStatus;
}

export type FutureExecutionUpdatedOperation = "created" | "updated" | "deleted";

export function buildExtensionEventEffect<K extends ServerExtensionEventName>(
	instanceId: string,
	type: K,
	payload: ServerExtensionEventPayloadInputMap[K],
): PostCommitEffect {
	return {
		kind: "extension_event",
		event: createDeferredExtensionEvent(instanceId, type, payload),
	};
}

export type PostCommitEffect =
	| { kind: "broadcast"; frame: DurableWsFrameInput }
	| {
			kind: "future_execution_updated";
			futureExecution: Pick<FutureExecution, "id" | "kind" | "instanceId">;
			operation: FutureExecutionUpdatedOperation;
	  }
	| {
			kind: "dispatch_inputs";
			instanceId: string;
			inputs: ProcessInput[];
			spawnIfMissing: boolean;
	  }
	| { kind: "worker"; instanceId: string; effect: WorkerIntent }
	| {
			kind: "worker_reconcile";
			instanceId: string;
			processId: string;
			change: WorkerReconcileEffectChange;
	  }
	| { kind: "extension_event"; event: DeferredProcessExtensionEvent }
	| {
			kind: "queue_process_title";
			processId: string;
			launchPlan: ProcessLaunchPlan;
			launchRunId?: string;
	  }
	| {
			kind: "queue_future_execution_title";
			futureExecutionId: string;
			launchPlan: ProcessLaunchPlan;
			expectedPayloadJson?: string;
	  };
