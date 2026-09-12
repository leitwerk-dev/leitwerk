import { assertValidProcessProductName, type ProcessProductRef } from "@leitwerk-dev/domain";
import type { WorkerInputConsumedPayload } from "@leitwerk-dev/worker-protocol";

import { mergeEntryRefPatchIntoStateJson } from "./entry-ref-patch.js";

export type ProcessProductRefPatch = Record<string, ProcessProductRef | null | undefined>;

export function mergeProductRefPatchIntoStateJson(
	stateJson: string | null | undefined,
	patch: ProcessProductRefPatch,
	options: { fallbackStateJson?: string | null | undefined } = {},
): string | null {
	return mergeEntryRefPatchIntoStateJson(stateJson, patch, "productRefs", options);
}

export function deriveInputConsumedProductRefPatch(
	payload: Pick<WorkerInputConsumedPayload, "targetProductName" | "targetEntryId">,
): ProcessProductRefPatch {
	if (!payload.targetProductName) {
		return {};
	}
	assertValidProcessProductName(payload.targetProductName);
	return {
		[payload.targetProductName]: payload.targetEntryId
			? { entryId: payload.targetEntryId, turnRecordId: null }
			: null,
	};
}

export function deriveTurnOutcomeProductRefPatch(input: {
	turnRecordId: string;
	publishedProduct?: string | null;
	resultPiEntryId?: string | null;
}): ProcessProductRefPatch {
	if (!input.publishedProduct) {
		return {};
	}
	assertValidProcessProductName(input.publishedProduct);
	const resultPiEntryId = input.resultPiEntryId?.trim();
	if (!resultPiEntryId) {
		throw new Error(
			`Cannot derive product ref patch for published product '${input.publishedProduct}' without a result entry`,
		);
	}
	return {
		[input.publishedProduct]: {
			entryId: resultPiEntryId,
			turnRecordId: input.turnRecordId,
		},
	};
}
