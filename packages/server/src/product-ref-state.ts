import {
	assertValidProcessProductName,
	type ProcessProductRef,
	type ProcessProductRefs,
	parseProcessStateJsonStrict,
	parseProductRefsStrict,
} from "@leitwerk-dev/domain";
import type { WorkerInputConsumedPayload } from "@leitwerk-dev/worker-protocol";

export type ProcessProductRefPatch = Record<string, ProcessProductRef | null | undefined>;

function productRefsEqual(a: ProcessProductRef | null, b: ProcessProductRef | null): boolean {
	return (
		(a?.entryId ?? null) === (b?.entryId ?? null) &&
		(a?.turnRecordId ?? null) === (b?.turnRecordId ?? null)
	);
}

function normalizeProductRef(
	value: ProcessProductRef | null | undefined,
): ProcessProductRef | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (value === null) {
		return null;
	}
	const entryId = value.entryId.trim();
	const turnRecordId = value.turnRecordId?.trim() || null;
	if (!entryId) {
		return null;
	}
	return { entryId, turnRecordId };
}

export function mergeProductRefPatchIntoStateJson(
	stateJson: string | null | undefined,
	patch: ProcessProductRefPatch,
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
	const currentRefs = parseProductRefsStrict(
		stateRecord.productRefs !== undefined
			? stateRecord.productRefs
			: fallbackStateRecord.productRefs,
	);
	const nextRefs: ProcessProductRefs = { ...currentRefs };
	let changed = false;
	for (const [rawName, rawValue] of entries) {
		assertValidProcessProductName(rawName);
		const nextValue = normalizeProductRef(rawValue);
		if (nextValue === undefined) {
			continue;
		}
		const previousValue = currentRefs[rawName] ?? null;
		if (!productRefsEqual(previousValue, nextValue)) {
			changed = true;
		}
		if (nextValue === null) {
			delete nextRefs[rawName];
		} else {
			nextRefs[rawName] = nextValue;
		}
	}
	if (!changed) {
		return null;
	}
	return JSON.stringify({
		...stateRecord,
		productRefs: nextRefs,
	});
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
