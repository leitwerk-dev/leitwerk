export const PROCESS_SEMANTIC_ENTRY_REF_KEYS = [
	"plan",
	"review",
	"currentPrimaryPathLeaf",
	"rootEntry",
] as const;

export type ProcessSemanticEntryRefKey = (typeof PROCESS_SEMANTIC_ENTRY_REF_KEYS)[number];

export interface SemanticEntryRef {
	entryId: string;
	turnRecordId: string | null;
}

export type ProcessProductRef = SemanticEntryRef;
export type ProcessProductRefs = Record<string, ProcessProductRef>;

const PRODUCT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function isValidProcessProductName(value: string): boolean {
	return PRODUCT_NAME_PATTERN.test(value);
}

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
export interface ProcessSemanticEntryRefs {
	plan: SemanticEntryRef | null;
	review: SemanticEntryRef | null;
	currentPrimaryPathLeaf: SemanticEntryRef | null;
	rootEntry: SemanticEntryRef | null;
}

function parseSemanticEntryId(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function isProcessSemanticEntryRefKey(value: string): value is ProcessSemanticEntryRefKey {
	return (PROCESS_SEMANTIC_ENTRY_REF_KEYS as readonly string[]).includes(value);
}

export function parseSemanticEntryRef(value: unknown): SemanticEntryRef | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const entryId = parseSemanticEntryId(record.entryId);
	if (!entryId) {
		return null;
	}
	return {
		entryId,
		turnRecordId: parseSemanticEntryId(record.turnRecordId),
	};
}

export function createEmptyProcessSemanticEntryRefs(): ProcessSemanticEntryRefs {
	return {
		plan: null,
		review: null,
		currentPrimaryPathLeaf: null,
		rootEntry: null,
	};
}

export function createEmptyProcessProductRefs(): ProcessProductRefs {
	return {};
}

export function parseProcessProductRefs(value: unknown): ProcessProductRefs {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return createEmptyProcessProductRefs();
	}
	const refs: ProcessProductRefs = {};
	for (const [name, rawRef] of Object.entries(value as Record<string, unknown>)) {
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

export function parseProcessSemanticEntryRefs(value: unknown): ProcessSemanticEntryRefs {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return createEmptyProcessSemanticEntryRefs();
	}
	const record = value as Record<string, unknown>;
	return {
		plan: parseSemanticEntryRef(record.plan),
		review: parseSemanticEntryRef(record.review),
		currentPrimaryPathLeaf: parseSemanticEntryRef(record.currentPrimaryPathLeaf),
		rootEntry: parseSemanticEntryRef(record.rootEntry),
	};
}
