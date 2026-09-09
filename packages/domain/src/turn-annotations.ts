import {
	isProcessSemanticEntryRefKey,
	type ProcessSemanticEntryRefKey,
} from "./semantic-entry-refs.js";
import { trimToNull } from "./string-normalize.js";

export const TURN_ANNOTATION_REFERENCE_KINDS = [
	"turn_record",
	"entry",
	"semantic_entry_ref",
] as const;

export type TurnAnnotationReferenceKind = (typeof TURN_ANNOTATION_REFERENCE_KINDS)[number];
export type TurnAnnotationReferenceRole = string;

export interface TurnRecordAnnotationReference {
	kind: "turn_record";
	turnRecordId: string;
	role: TurnAnnotationReferenceRole | null;
}

export interface EntryTurnAnnotationReference {
	kind: "entry";
	entryId: string;
	role: TurnAnnotationReferenceRole | null;
}

export interface SemanticEntryRefTurnAnnotationReference {
	kind: "semantic_entry_ref";
	ref: ProcessSemanticEntryRefKey;
	role: TurnAnnotationReferenceRole | null;
}

export type TurnAnnotationReference =
	| TurnRecordAnnotationReference
	| EntryTurnAnnotationReference
	| SemanticEntryRefTurnAnnotationReference;

export interface ProcessTurnAnnotation {
	id: string;
	instanceId: string;
	annotationType: string;
	annotationKey: string | null;
	references: TurnAnnotationReference[];
	payload: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

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

export function parseTurnAnnotationReferences(value: unknown): TurnAnnotationReference[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map(parseTurnAnnotationReference)
		.filter((reference): reference is TurnAnnotationReference => reference !== null);
}
