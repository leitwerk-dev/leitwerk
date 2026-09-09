import {
	type ProcessSemanticEntryRefKey,
	parseProcessStateJsonStrict,
	parseSemanticEntryRef,
	parseSemanticEntryRefsStrict,
	type SemanticEntryRef,
	type TurnOutcomePayload,
} from "@leitwerk-dev/domain";
import type { WorkerInputConsumedPayload } from "@leitwerk-dev/worker-protocol";

export type ProcessSemanticEntryRefPatch = Partial<
	Record<
		ProcessSemanticEntryRefKey,
		| {
				entryId: string;
				turnRecordId?: string | null;
		  }
		| null
		| undefined
	>
>;

function semanticEntryRefsEqual(a: SemanticEntryRef | null, b: SemanticEntryRef | null): boolean {
	return a?.entryId === b?.entryId && a?.turnRecordId === b?.turnRecordId;
}

export function mergeSemanticEntryRefPatchIntoStateJson(
	stateJson: string | null | undefined,
	patch: ProcessSemanticEntryRefPatch,
	options: { fallbackStateJson?: string | null | undefined } = {},
): string | null {
	const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
	if (entries.length === 0) {
		return null;
	}

	const stateRecord = parseProcessStateJsonStrict(stateJson, "stateJson");
	const fallbackStateRecord = parseProcessStateJsonStrict(
		options.fallbackStateJson,
		"fallbackStateJson",
	);
	const currentRefs = parseSemanticEntryRefsStrict(
		stateRecord.semanticEntryRefs !== undefined
			? stateRecord.semanticEntryRefs
			: fallbackStateRecord.semanticEntryRefs,
	);
	const nextRefs = { ...currentRefs };
	let changed = false;

	for (const [rawKey, rawValue] of entries) {
		const key = rawKey as ProcessSemanticEntryRefKey;
		const nextValue = parseSemanticEntryRef(rawValue);
		if (!semanticEntryRefsEqual(currentRefs[key], nextValue)) {
			changed = true;
		}
		nextRefs[key] = nextValue;
	}

	if (!changed) {
		return null;
	}

	return JSON.stringify({
		...stateRecord,
		semanticEntryRefs: nextRefs,
	});
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
