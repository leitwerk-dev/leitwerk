import type {
	Actor,
	InputKind,
	InputSource,
	ProcessInput,
	ProcessInputTarget,
} from "@leitwerk-dev/domain";
import { parseActorOrSystem, SYSTEM_ACTOR, serializeActor } from "@leitwerk-dev/domain";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface CreateProcessInputInput {
	instanceId: string;
	sequence: number;
	source: InputSource;
	kind: InputKind;
	target?: ProcessInputTarget | null;
	bodyMarkdown: string;
	actor?: Actor;
}

function toProcessInputTarget(
	semanticRef: string | null,
	productName: string | null,
): ProcessInputTarget | null {
	if (productName) {
		return { productName };
	}
	return semanticRef
		? { semanticRef: semanticRef as NonNullable<ProcessInputTarget["semanticRef"]> }
		: null;
}

function rowToProcessInput(row: typeof s.processInputs.$inferSelect): ProcessInput {
	return {
		id: row.id,
		instanceId: row.instanceId,
		sequence: row.sequence,
		source: row.source as InputSource,
		kind: row.kind as InputKind,
		target: toProcessInputTarget(row.targetSemanticRef, row.targetProductName),
		bodyMarkdown: row.bodyMarkdown,
		actor: parseActorOrSystem(row.actor),
		receivedAt: row.receivedAt,
		consumedAt: row.consumedAt,
	};
}

export function createProcessInputRepo(db: LeitwerkDb) {
	return {
		create(input: CreateProcessInputInput): ProcessInput {
			const id = generateId("inp");
			const ts = now();
			const values = {
				id,
				instanceId: input.instanceId,
				sequence: input.sequence,
				source: input.source,
				kind: input.kind,
				targetSemanticRef: input.target?.semanticRef ?? null,
				targetProductName: input.target?.productName ?? null,
				bodyMarkdown: input.bodyMarkdown,
				actor: serializeActor(input.actor ?? SYSTEM_ACTOR),
				receivedAt: ts,
				consumedAt: null as string | null,
			};
			db.insert(s.processInputs).values(values).run();
			return rowToProcessInput(values);
		},

		listByInstance(instanceId: string): ProcessInput[] {
			return db
				.select()
				.from(s.processInputs)
				.where(eq(s.processInputs.instanceId, instanceId))
				.orderBy(asc(s.processInputs.sequence))
				.all()
				.map(rowToProcessInput);
		},

		listUnconsumed(instanceId: string): ProcessInput[] {
			return db
				.select()
				.from(s.processInputs)
				.where(and(eq(s.processInputs.instanceId, instanceId), isNull(s.processInputs.consumedAt)))
				.orderBy(asc(s.processInputs.sequence))
				.all()
				.map(rowToProcessInput);
		},

		markConsumed(id: string): boolean {
			const result = db
				.update(s.processInputs)
				.set({ consumedAt: now() })
				.where(eq(s.processInputs.id, id))
				.run();
			return result.changes > 0;
		},

		delete(id: string): boolean {
			const result = db.delete(s.processInputs).where(eq(s.processInputs.id, id)).run();
			return result.changes > 0;
		},

		getMaxSequence(instanceId: string): number {
			const row = db
				.select()
				.from(s.processInputs)
				.where(eq(s.processInputs.instanceId, instanceId))
				.orderBy(desc(s.processInputs.sequence))
				.limit(1)
				.get();
			return row ? row.sequence : 0;
		},
	};
}
