import {
	isProcessSemanticEntryRefKey,
	type ProcessSemanticEntryRefKey,
} from "./semantic-entry-refs.js";
import { trimToNull } from "./string-normalize.js";

/** @internal */
export const TURN_ANNOTATION_REFERENCE_KINDS = [
	"turn_record",
	"entry",
	"semantic_entry_ref",
] as const;

/** @internal */
export type TurnAnnotationReferenceKind = (typeof TURN_ANNOTATION_REFERENCE_KINDS)[number];
/** @internal */
export type TurnAnnotationReferenceRole = string;

/** @internal */
export interface TurnRecordAnnotationReference {
	/** @internal */
	kind: "turn_record";
	/** @internal */
	turnRecordId: string;
	/** @internal */
	role: TurnAnnotationReferenceRole | null;
}

/** @internal */
export interface EntryTurnAnnotationReference {
	/** @internal */
	kind: "entry";
	/** @internal */
	entryId: string;
	/** @internal */
	role: TurnAnnotationReferenceRole | null;
}

/** @internal */
export interface SemanticEntryRefTurnAnnotationReference {
	/** @internal */
	kind: "semantic_entry_ref";
	/** @internal */
	ref: ProcessSemanticEntryRefKey;
	/** @internal */
	role: TurnAnnotationReferenceRole | null;
}

/** @internal */
export type TurnAnnotationReference =
	| TurnRecordAnnotationReference
	| EntryTurnAnnotationReference
	| SemanticEntryRefTurnAnnotationReference;

/** @internal */
export interface ProcessTurnAnnotation {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	annotationType: string;
	/** @internal */
	annotationKey: string | null;
	/** @internal */
	references: TurnAnnotationReference[];
	/** @internal */
	payload: Record<string, unknown>;
	/** @internal */
	createdAt: string;
	/** @internal */
	updatedAt: string;
}

/** @internal */
export function parseTurnAnnotationReference(value: unknown): TurnAnnotationReference | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const kind = trimToNull(record.kind);
	const role = trimToNull(record.role);
	if (kind === "turn_record") {
		const turnRecordId = trimToNull(record.turnRecordId);
		return turnRecordId ? { kind, turnRecordId, role } : null;
	}
	if (kind === "entry") {
		const entryId = trimToNull(record.entryId);
		return entryId ? { kind, entryId, role } : null;
	}
	if (kind === "semantic_entry_ref") {
		const ref = trimToNull(record.ref);
		return ref && isProcessSemanticEntryRefKey(ref) ? { kind, ref, role } : null;
	}
	return null;
}

/** @internal */
export function parseTurnAnnotationReferences(value: unknown): TurnAnnotationReference[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map(parseTurnAnnotationReference)
		.filter((reference): reference is TurnAnnotationReference => reference !== null);
}
