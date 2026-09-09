import type {
	LaunchChecklistStep,
	LaunchOrigin,
	LaunchRun,
	LaunchRunStatus,
} from "@leitwerk-dev/domain";
import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

const ACTIVE_STATUSES: readonly LaunchRunStatus[] = ["preparing", "process_created", "starting"];

function parseSteps(value: string): LaunchChecklistStep[] {
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) throw new Error("Invalid launch checklist state");
	return parsed as LaunchChecklistStep[];
}

function toLaunchRun(row: typeof s.launchRuns.$inferSelect): LaunchRun {
	return {
		id: row.id,
		launcherId: row.launcherId ?? null,
		origin: row.origin as LaunchOrigin,
		instanceId: row.instanceId ?? null,
		status: row.status as LaunchRunStatus,
		steps: parseSteps(row.stepsJson),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		completedAt: row.completedAt ?? null,
		revision: row.revision,
	};
}

export interface CreateLaunchRunInput {
	launcherId: string | null;
	idempotencyKey?: string | null;
	origin: LaunchOrigin;
	steps: readonly LaunchChecklistStep[];
}

export function createLaunchRunRepo(db: LeitwerkDb) {
	const list = (where: SQL): LaunchRun[] =>
		db
			.select()
			.from(s.launchRuns)
			.where(where)
			.orderBy(asc(s.launchRuns.createdAt), asc(s.launchRuns.id))
			.all()
			.map(toLaunchRun);
	return {
		create(input: CreateLaunchRunInput): LaunchRun {
			const ts = now();
			const row = {
				id: generateId("lnr"),
				idempotencyKey: input.idempotencyKey ?? null,
				launcherId: input.launcherId,
				origin: input.origin,
				instanceId: null,
				status: "preparing",
				stepsJson: JSON.stringify(input.steps),
				createdAt: ts,
				updatedAt: ts,
				completedAt: null,
				revision: 0,
			} satisfies typeof s.launchRuns.$inferInsert;
			db.insert(s.launchRuns).values(row).run();
			return toLaunchRun(row);
		},

		getById(id: string): LaunchRun | null {
			const row = db.select().from(s.launchRuns).where(eq(s.launchRuns.id, id)).get();
			return row ? toLaunchRun(row) : null;
		},

		saveReplay(runId: string, payload: unknown): void {
			db.insert(s.launchRunReplays)
				.values({ launchRunId: runId, payloadJson: JSON.stringify(payload) })
				.onConflictDoUpdate({
					target: s.launchRunReplays.launchRunId,
					set: { payloadJson: JSON.stringify(payload) },
				})
				.run();
		},

		getReplay<T>(runId: string): T | null {
			const row = db
				.select({ payloadJson: s.launchRunReplays.payloadJson })
				.from(s.launchRunReplays)
				.where(eq(s.launchRunReplays.launchRunId, runId))
				.get();
			return row ? (JSON.parse(row.payloadJson) as T) : null;
		},

		deleteReplay(runId: string): void {
			db.delete(s.launchRunReplays).where(eq(s.launchRunReplays.launchRunId, runId)).run();
		},

		getByIdempotencyKey(key: string): LaunchRun | null {
			const row = db.select().from(s.launchRuns).where(eq(s.launchRuns.idempotencyKey, key)).get();
			return row ? toLaunchRun(row) : null;
		},

		archiveIdempotencyKey(id: string, key: string): void {
			db.update(s.launchRuns)
				.set({ idempotencyKey: `${key}:attempt:${id}` })
				.where(and(eq(s.launchRuns.id, id), eq(s.launchRuns.idempotencyKey, key)))
				.run();
		},

		listByInstance: (instanceId: string) => list(eq(s.launchRuns.instanceId, instanceId)),
		listIncomplete: () => list(inArray(s.launchRuns.status, [...ACTIVE_STATUSES])),

		compareAndSet(next: LaunchRun, expectedRevision: number): LaunchRun | null {
			const updatedAt = now();
			const result = db
				.update(s.launchRuns)
				.set({
					launcherId: next.launcherId,
					origin: next.origin,
					instanceId: next.instanceId,
					status: next.status,
					stepsJson: JSON.stringify(next.steps),
					updatedAt,
					completedAt: next.completedAt,
					revision: expectedRevision + 1,
				})
				.where(and(eq(s.launchRuns.id, next.id), eq(s.launchRuns.revision, expectedRevision)))
				.run();
			return result.changes > 0 ? this.getById(next.id) : null;
		},

		update(id: string, mutate: (current: LaunchRun) => LaunchRun): LaunchRun | null {
			for (let attempt = 0; attempt < 8; attempt += 1) {
				const current = this.getById(id);
				if (!current) return null;
				const updated = this.compareAndSet(mutate(current), current.revision);
				if (updated) return updated;
			}
			throw new Error(`Launch run '${id}' could not be updated concurrently`);
		},
	};
}
