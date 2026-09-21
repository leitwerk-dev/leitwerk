import type { ProcessSemanticEntryRefKey, TurnOutcomePayload } from "@leitwerk-dev/domain";
import type { WorkerInputConsumedPayload } from "@leitwerk-dev/worker-protocol";

import { type EntryRefPatch, mergeEntryRefPatchIntoStateJson } from "./entry-ref-patch.js";

/** @internal */
export type ProcessSemanticEntryRefPatch = Partial<
	Record<ProcessSemanticEntryRefKey, EntryRefPatch[string]>
>;

export function mergeSemanticEntryRefPatchIntoStateJson(
	stateJson: string | null | undefined,
	patch: ProcessSemanticEntryRefPatch,
	options: { fallbackStateJson?: string | null | undefined } = {},
): string | null {
	return mergeEntryRefPatchIntoStateJson(stateJson, patch, "semanticEntryRefs", options);
}

export function deriveTurnOutcomeSemanticEntryRefPatch(
	payload: Pick<TurnOutcomePayload, "turnRecordId" | "pathType" | "resultPiEntryId"> & {
		resultSemanticRef?: ProcessSemanticEntryRefKey | null;
		rootEntryId?: string | null;
	},
): ProcessSemanticEntryRefPatch {
	const patch: ProcessSemanticEntryRefPatch = {};

	if (payload.rootEntryId !== undefined) {
		patch.rootEntry = payload.rootEntryId
			? { entryId: payload.rootEntryId, turnRecordId: null }
			: null;
	}

	if (payload.resultPiEntryId) {
		if (payload.pathType === "primary") {
			patch.currentPrimaryPathLeaf = {
				entryId: payload.resultPiEntryId,
				turnRecordId: payload.turnRecordId,
			};
		}
		if (payload.resultSemanticRef) {
			patch[payload.resultSemanticRef] = {
				entryId: payload.resultPiEntryId,
				turnRecordId: payload.turnRecordId,
			};
		}
	}

	return patch;
}

export function deriveInputConsumedSemanticEntryRefPatch(
	payload: Pick<
		WorkerInputConsumedPayload,
		"currentPrimaryPathLeafId" | "rootEntryId" | "targetSemanticRef" | "targetEntryId"
	>,
): ProcessSemanticEntryRefPatch {
	const patch: ProcessSemanticEntryRefPatch = {};

	if (payload.currentPrimaryPathLeafId !== undefined) {
		patch.currentPrimaryPathLeaf = payload.currentPrimaryPathLeafId
			? { entryId: payload.currentPrimaryPathLeafId, turnRecordId: null }
			: null;
	}
	if (payload.rootEntryId !== undefined) {
		patch.rootEntry = payload.rootEntryId
			? { entryId: payload.rootEntryId, turnRecordId: null }
			: null;
	}
	if (payload.targetSemanticRef) {
		patch[payload.targetSemanticRef] = payload.targetEntryId
			? { entryId: payload.targetEntryId, turnRecordId: null }
			: null;
	}

	return patch;
}
