import {
	isProcessSemanticEntryRefKey,
	type ProcessSemanticEntryRefKey,
} from "./semantic-entry-refs.js";

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

function parseNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function parseTurnAnnotationReferenceRole(value: unknown): TurnAnnotationReferenceRole | null {
	return parseNonEmptyString(value);
}

export function parseTurnAnnotationReference(value: unknown): TurnAnnotationReference | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const kind = parseNonEmptyString(record.kind);
	const role = parseTurnAnnotationReferenceRole(record.role);
	if (!kind) {
		return null;
	}
	if (kind === "turn_record") {
		const turnRecordId = parseNonEmptyString(record.turnRecordId);
		return turnRecordId ? { kind, turnRecordId, role } : null;
	}
	if (kind === "entry") {
		const entryId = parseNonEmptyString(record.entryId);
		return entryId ? { kind, entryId, role } : null;
	}
	if (kind === "semantic_entry_ref") {
		const ref = parseNonEmptyString(record.ref);
		return ref && isProcessSemanticEntryRefKey(ref) ? { kind, ref, role } : null;
	}
	return null;
}

export function parseTurnAnnotationReferences(value: unknown): TurnAnnotationReference[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value
		.map((reference) => parseTurnAnnotationReference(reference))
		.filter((reference): reference is TurnAnnotationReference => reference !== null);
}
