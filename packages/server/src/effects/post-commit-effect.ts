import type { FutureExecution, ProcessInput } from "@leitwerk-dev/domain";
import type {
	ProcessLaunchPlan,
	ServerExtensionEventName,
	ServerExtensionEventPayloadInputMap,
} from "@leitwerk-dev/process-sdk";
import type { DurableWsFrameInput } from "@leitwerk-dev/protocol";
import type { ProcessTurnSelectionChange } from "../process-engine/types.js";
import {
	createDeferredExtensionEvent,
	type DeferredProcessExtensionEvent,
} from "../process-engine/writes/deferred-extension-events.js";
import type { WorkerIntent } from "../process-engine/writes/writes.js";

/** @internal */
export interface WorkerReconcileEffectChange extends ProcessTurnSelectionChange {}

/** @internal */
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

/** @internal */
export type PostCommitEffect =
	| {
			/** @internal */
			kind: "broadcast";
			/** @internal */
			frame: DurableWsFrameInput;
	  }
	| {
			/** @internal */
			kind: "future_execution_updated";
			/** @internal */
			futureExecution: Pick<FutureExecution, "id" | "kind" | "instanceId">;
			/** @internal */
			operation: FutureExecutionUpdatedOperation;
	  }
	| {
			/** @internal */
			kind: "dispatch_inputs";
			/** @internal */
			instanceId: string;
			/** @internal */
			inputs: ProcessInput[];
			/** @internal */
			spawnIfMissing: boolean;
	  }
	| {
			/** @internal */
			kind: "worker";
			/** @internal */
			instanceId: string;
			/** @internal */
			effect: WorkerIntent;
	  }
	| {
			/** @internal */
			kind: "worker_reconcile";
			/** @internal */
			instanceId: string;
			/** @internal */
			processId: string;
			/** @internal */
			change: WorkerReconcileEffectChange;
	  }
	| {
			/** @internal */
			kind: "extension_event";
			/** @internal */
			event: DeferredProcessExtensionEvent;
	  }
	| {
			/** @internal */
			kind: "queue_process_title";
			/** @internal */
			processId: string;
			/** @internal */
			launchPlan: ProcessLaunchPlan;
			/** @internal */
			launchRunId?: string;
	  }
	| {
			/** @internal */
			kind: "queue_future_execution_title";
			/** @internal */
			futureExecutionId: string;
			/** @internal */
			launchPlan: ProcessLaunchPlan;
			/** @internal */
			expectedPayloadJson?: string;
	  };
