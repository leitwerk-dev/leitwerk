import type { Actor, NormalizedQuestion, ProcessQuestionRequest } from "@leitwerk-dev/domain";
import { and, asc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now, parsePersistedJson } from "./repo-helpers.js";
import * as s from "./schema.js";

function map(row: typeof s.processQuestionRequests.$inferSelect): ProcessQuestionRequest {
	return {
		id: row.id,
		instanceId: row.instanceId,
		turnRecordId: row.turnRecordId,
		toolCallId: row.toolCallId,
		questions: parsePersistedJson<NormalizedQuestion[]>(row.questionsJson, "question request"),
		status: row.status as ProcessQuestionRequest["status"],
		answers: row.answersJson
			? parsePersistedJson<string[]>(row.answersJson, "question answers")
			: null,
		askedAt: row.askedAt,
		answeredAt: row.answeredAt ?? null,
		answeredBy: row.answeredByJson
			? parsePersistedJson<Actor>(row.answeredByJson, "answer actor")
			: null,
		cancelledAt: row.cancelledAt ?? null,
	};
}

export interface CreateQuestionRequestInput {
	instanceId: string;
	turnRecordId: string;
	toolCallId: string;
	questions: readonly NormalizedQuestion[];
	askedAt?: string;
}

export function createProcessQuestionRequestRepo(db: LeitwerkDb) {
	const getById = (id: string): ProcessQuestionRequest | null => {
		const row = db
			.select()
			.from(s.processQuestionRequests)
			.where(eq(s.processQuestionRequests.id, id))
			.get();
		return row ? map(row) : null;
	};
	const list = (instanceId?: string, openOnly = false): ProcessQuestionRequest[] => {
		const filters = [
			...(instanceId ? [eq(s.processQuestionRequests.instanceId, instanceId)] : []),
			...(openOnly ? [eq(s.processQuestionRequests.status, "open")] : []),
		];
		return db
			.select()
			.from(s.processQuestionRequests)
			.where(filters.length ? and(...filters) : undefined)
			.orderBy(asc(s.processQuestionRequests.askedAt))
			.all()
			.map(map);
	};
	return {
		getById,
		listByInstance: (instanceId: string) => list(instanceId),
		listOpen: (instanceId?: string) => list(instanceId, true),
		createIdempotent(input: CreateQuestionRequestInput): {
			kind: "created" | "replay";
			request: ProcessQuestionRequest;
		} {
			const existingRow = db
				.select()
				.from(s.processQuestionRequests)
				.where(
					and(
						eq(s.processQuestionRequests.instanceId, input.instanceId),
						eq(s.processQuestionRequests.turnRecordId, input.turnRecordId),
						eq(s.processQuestionRequests.toolCallId, input.toolCallId),
					),
				)
				.get();
			if (existingRow) {
				const existing = map(existingRow);
				if (JSON.stringify(existing.questions) !== JSON.stringify(input.questions)) {
					throw new Error("Question request correlation was replayed with different questions");
				}
				return { kind: "replay", request: existing };
			}
			const row = db
				.insert(s.processQuestionRequests)
				.values({
					id: generateId("qst"),
					instanceId: input.instanceId,
					turnRecordId: input.turnRecordId,
					toolCallId: input.toolCallId,
					questionsJson: JSON.stringify(input.questions),
					askedAt: input.askedAt ?? now(),
				})
				.returning()
				.get();
			return { kind: "created", request: map(row) };
		},
		answer(input: {
			id: string;
			answers: readonly string[];
			actor: Actor;
			answeredAt?: string;
		}): ProcessQuestionRequest | null {
			const row = db
				.update(s.processQuestionRequests)
				.set({
					status: "answered",
					answersJson: JSON.stringify(input.answers),
					answeredAt: input.answeredAt ?? now(),
					answeredByJson: JSON.stringify(input.actor),
				})
				.where(
					and(
						eq(s.processQuestionRequests.id, input.id),
						eq(s.processQuestionRequests.status, "open"),
					),
				)
				.returning()
				.get();
			return row ? map(row) : null;
		},
		cancelOpenByTurn(instanceId: string, turnRecordId: string): number {
			return db
				.update(s.processQuestionRequests)
				.set({ status: "cancelled", cancelledAt: now() })
				.where(
					and(
						eq(s.processQuestionRequests.instanceId, instanceId),
						eq(s.processQuestionRequests.turnRecordId, turnRecordId),
						eq(s.processQuestionRequests.status, "open"),
					),
				)
				.run().changes;
		},
	};
}
