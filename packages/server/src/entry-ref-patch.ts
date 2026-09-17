import {
	areSemanticEntryRefsEqual,
	assertValidProcessProductName,
	parseProcessStateJsonStrict,
	parseProductRefsStrict,
	parseSemanticEntryRef,
	parseSemanticEntryRefsStrict,
	type SemanticEntryRef,
} from "@leitwerk-dev/domain";

/** @internal */
export type EntryRefPatch = Record<
	string,
	| {
			/** @internal */
			entryId: string;
			/** @internal */
			turnRecordId?: string | null;
	  }
	| null
	| undefined
>;

export function mergeEntryRefPatchIntoStateJson(
	stateJson: string | null | undefined,
	patch: EntryRefPatch,
	field: "productRefs" | "semanticEntryRefs",
	options: { fallbackStateJson?: string | null | undefined } = {},
): string | null {
	const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return null;
	const stateRecord = parseProcessStateJsonStrict(stateJson, "stateJson");
	const fallbackStateRecord = parseProcessStateJsonStrict(
		options.fallbackStateJson,
		"fallbackStateJson",
	);
	const parseRefs = field === "productRefs" ? parseProductRefsStrict : parseSemanticEntryRefsStrict;
	const nextRefs: Record<string, SemanticEntryRef | null> = {
		...parseRefs(
			stateRecord[field] !== undefined ? stateRecord[field] : fallbackStateRecord[field],
		),
	};
	let changed = false;
	for (const [key, value] of entries) {
		if (field === "productRefs") assertValidProcessProductName(key);
		if (value === undefined) continue;
		const nextValue =
			field === "productRefs" ? normalizeProductRef(value) : parseSemanticEntryRef(value);
		if (!areSemanticEntryRefsEqual(nextRefs[key], nextValue)) changed = true;
		// Products omit deleted keys; semantic refs retain explicit null slots.
		if (field === "productRefs" && nextValue === null) delete nextRefs[key];
		else nextRefs[key] = nextValue;
	}
	return changed ? JSON.stringify({ ...stateRecord, [field]: nextRefs }) : null;
}

function normalizeProductRef(
	value: Exclude<EntryRefPatch[string], undefined>,
): SemanticEntryRef | null {
	if (value === null) return null;
	const entryId = value.entryId.trim();
	const turnRecordId = value.turnRecordId?.trim() || null;
	return entryId ? { entryId, turnRecordId } : null;
}
