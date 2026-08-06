import type { ProcessTurnAnnotation, TurnAnnotationReference } from "@leitwerk-dev/domain";
import { parseTurnAnnotationReferences } from "@leitwerk-dev/domain";
import { and, asc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface CreateProcessTurnAnnotationInput {
	id?: string;
	instanceId: string;
	annotationType: string;
	/** Null means append-only and therefore not addressable via upsert key. */
	annotationKey?: string | null;
	references?: readonly TurnAnnotationReference[];
	payload?: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
}

export interface UpdateProcessTurnAnnotationInput {
	annotationType?: string;
	/** Null means append-only and therefore not addressable via upsert key. */
	annotationKey?: string | null;
	references?: readonly TurnAnnotationReference[];
	payload?: Record<string, unknown>;
	updatedAt?: string;
}

function parsePayload(value: string | null | undefined): Record<string, unknown> {
	if (!value) {
		return {};
	}
	try {
		const parsed = JSON.parse(value) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function parseReferences(value: string): TurnAnnotationReference[] {
	try {
		return parseTurnAnnotationReferences(JSON.parse(value));
	} catch {
		return [];
	}
}

function rowToProcessTurnAnnotation(
	row: typeof s.turnAnnotations.$inferSelect,
): ProcessTurnAnnotation {
	return {
		id: row.id,
		instanceId: row.instanceId,
		annotationType: row.annotationType,
		annotationKey: row.annotationKey ?? null,
		references: parseReferences(row.referencesJson),
		payload: parsePayload(row.payloadJson),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function createProcessTurnAnnotationRepo(db: LeitwerkDb) {
	return {
		create(input: CreateProcessTurnAnnotationInput): ProcessTurnAnnotation {
			const id = input.id ?? generateId("tan");
			const createdAt = input.createdAt ?? now();
			const updatedAt = input.updatedAt ?? createdAt;
			const values = {
				id,
				instanceId: input.instanceId,
				annotationType: input.annotationType,
				annotationKey: input.annotationKey ?? null,
				referencesJson: JSON.stringify(input.references ?? []),
				payloadJson: JSON.stringify(input.payload ?? {}),
				createdAt,
				updatedAt,
			};
			db.insert(s.turnAnnotations).values(values).run();
			return rowToProcessTurnAnnotation(values);
		},

		getById(id: string): ProcessTurnAnnotation | null {
			const row = db.select().from(s.turnAnnotations).where(eq(s.turnAnnotations.id, id)).get();
			return row ? rowToProcessTurnAnnotation(row) : null;
		},

		findByKey(instanceId: string, annotationKey: string): ProcessTurnAnnotation | null {
			const key = annotationKey.trim();
			if (key.length === 0) {
				return null;
			}
			const row = db
				.select()
				.from(s.turnAnnotations)
				.where(
					and(
						eq(s.turnAnnotations.instanceId, instanceId),
						eq(s.turnAnnotations.annotationKey, key),
					),
				)
				.get();
			return row ? rowToProcessTurnAnnotation(row) : null;
		},

		listByInstance(instanceId: string): ProcessTurnAnnotation[] {
			return db
				.select()
				.from(s.turnAnnotations)
				.where(eq(s.turnAnnotations.instanceId, instanceId))
				.orderBy(asc(s.turnAnnotations.createdAt))
				.all()
				.map(rowToProcessTurnAnnotation);
		},

		update(id: string, input: UpdateProcessTurnAnnotationInput): ProcessTurnAnnotation | null {
			const setValues: Record<string, unknown> = {
				updatedAt: input.updatedAt ?? now(),
			};
			if (input.annotationType !== undefined) setValues.annotationType = input.annotationType;
			if (input.annotationKey !== undefined) setValues.annotationKey = input.annotationKey;
			if (input.references !== undefined)
				setValues.referencesJson = JSON.stringify(input.references);
			if (input.payload !== undefined) setValues.payloadJson = JSON.stringify(input.payload);

			db.update(s.turnAnnotations).set(setValues).where(eq(s.turnAnnotations.id, id)).run();
			return this.getById(id);
		},

		delete(id: string): boolean {
			const result = db.delete(s.turnAnnotations).where(eq(s.turnAnnotations.id, id)).run();
			return result.changes > 0;
		},
	};
}
