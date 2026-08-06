import { createDurableWsFrame } from "@leitwerk-dev/protocol";
import type { WorkerInputConsumedPayload } from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ProcessEngine } from "../process-engine/types.js";
import { deriveInputConsumedProductRefPatch } from "../product-ref-state.js";
import { deriveInputConsumedSemanticEntryRefPatch } from "../semantic-entry-ref-state.js";
import type { Broadcaster } from "../ws/broadcast.js";

export interface WorkerInputAckHandlerDeps extends Pick<RepositoryBundle, "inputs"> {
	broadcaster: Broadcaster;
	commands: ProcessEngine;
}

export function createWorkerInputAckHandler(deps: WorkerInputAckHandlerDeps) {
	return {
		handle(instanceId: string, payload: WorkerInputConsumedPayload): void {
			if (payload.inputId) {
				deps.inputs.markConsumed(payload.inputId);
				const input = deps.inputs
					.listByInstance(instanceId)
					.find((candidate) => candidate.id === payload.inputId);
				if (input) {
					deps.broadcaster.broadcast(
						createDurableWsFrame({
							type: "process.input.acknowledged",
							payload: {
								instanceId,
								inputId: input.id,
								sequence: input.sequence,
							},
							instanceId,
						}),
					);
				}
			}
			const semanticEntryRefPatch = deriveInputConsumedSemanticEntryRefPatch(payload);
			if (Object.keys(semanticEntryRefPatch).length > 0) {
				void deps.commands
					.updateSemanticEntryRefs(instanceId, semanticEntryRefPatch)
					.catch(() => {});
			}
			const productRefPatch = deriveInputConsumedProductRefPatch(payload);
			if (Object.keys(productRefPatch).length > 0) {
				void deps.commands.updateProductRefs(instanceId, productRefPatch).catch(() => {});
			}
		},
	};
}
