import { trimToNull } from "./string-normalize.js";
import { asUnknownRecord, isUnknownRecord } from "./unknown-record.js";

/** @public */
export const PROCESS_SEMANTIC_ENTRY_REF_KEYS = [
	"plan",
	"review",
	"currentPrimaryPathLeaf",
	"rootEntry",
] as const;

/** @public */
export type ProcessSemanticEntryRefKey = (typeof PROCESS_SEMANTIC_ENTRY_REF_KEYS)[number];

/** @internal */
export interface SemanticEntryRef {
	/** @internal */
	entryId: string;
	/** @internal */
	turnRecordId: string | null;
}

/** @internal */
export function areSemanticEntryRefsEqual(
	left: SemanticEntryRef | null | undefined,
	right: SemanticEntryRef | null | undefined,
): boolean {
	return (
		(left?.entryId ?? null) === (right?.entryId ?? null) &&
		(left?.turnRecordId ?? null) === (right?.turnRecordId ?? null)
	);
}

/** @internal */
export type ProcessProductRef = SemanticEntryRef;
/** @internal */
export type ProcessProductRefs = Record<string, ProcessProductRef>;

const PRODUCT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** @internal */
export function isValidProcessProductName(value: string): boolean {
	return PRODUCT_NAME_PATTERN.test(value);
}

/** @internal */
export function assertValidProcessProductName(value: string): void {
	if (!isValidProcessProductName(value)) {
		throw new Error(
			`Invalid process product name '${value}'. Product names must match ${PRODUCT_NAME_PATTERN.source}`,
		);
	}
}

/**
 * Stage 2 keeps these refs as structural placeholders initialized to `null`.
 * Current runtime population:
 * - `rootEntry` during worker bootstrap and subsequent worker tree-fact reporting
 * - `currentPrimaryPathLeaf` during worker bootstrap, successful primary turns,
 *   and prompt-style primary-path input delivery
 * - `plan` during successful planning turns; it remains the current plan through
 *   implementation until another planning turn replaces it
 * - `review` during successful review turns; it remains the current review until
 *   another review turn replaces it
 */
/** @internal */
export interface ProcessSemanticEntryRefs {
	/** @internal */
	plan: SemanticEntryRef | null;
	/** @internal */
	review: SemanticEntryRef | null;
	/** @internal */
	currentPrimaryPathLeaf: SemanticEntryRef | null;
	/** @internal */
	rootEntry: SemanticEntryRef | null;
}

/** @internal */
export function isProcessSemanticEntryRefKey(value: string): value is ProcessSemanticEntryRefKey {
	return (PROCESS_SEMANTIC_ENTRY_REF_KEYS as readonly string[]).includes(value);
}

/** @internal */
export function parseSemanticEntryRef(value: unknown): SemanticEntryRef | null {
	const record = asUnknownRecord(value);
	const entryId = trimToNull(record?.entryId);
	if (!entryId) {
		return null;
	}
	return {
		entryId,
		turnRecordId: trimToNull(record?.turnRecordId),
	};
}

/** @internal */
export function createEmptyProcessSemanticEntryRefs(): ProcessSemanticEntryRefs {
	return {
		plan: null,
		review: null,
		currentPrimaryPathLeaf: null,
		rootEntry: null,
	};
}

/** @internal */
export function createEmptyProcessProductRefs(): ProcessProductRefs {
	return {};
}

/** @internal */
export function parseProcessProductRefs(value: unknown): ProcessProductRefs {
	if (!isUnknownRecord(value)) return createEmptyProcessProductRefs();
	const refs: ProcessProductRefs = {};
	for (const [name, rawRef] of Object.entries(value)) {
		if (!isValidProcessProductName(name)) {
			continue;
		}
		const ref = parseSemanticEntryRef(rawRef);
		if (ref) {
			refs[name] = ref;
		}
	}
	return refs;
}

/** @internal */
export function parseProcessSemanticEntryRefs(value: unknown): ProcessSemanticEntryRefs {
	const record = asUnknownRecord(value) ?? {};
	return {
		plan: parseSemanticEntryRef(record.plan),
		review: parseSemanticEntryRef(record.review),
		currentPrimaryPathLeaf: parseSemanticEntryRef(record.currentPrimaryPathLeaf),
		rootEntry: parseSemanticEntryRef(record.rootEntry),
	};
}
