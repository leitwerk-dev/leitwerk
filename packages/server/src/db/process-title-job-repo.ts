import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export type ProcessTitleJob = typeof s.processTitleJobs.$inferSelect;

export type EnqueueProcessTitleJobInput = {
	processDefinitionId: string;
	modelProfileId: string;
	prompt: string;
	maxAttempts: number;
	nextRunAt: string;
} & (
	| { processInstanceId: string; launchRunId?: string | null }
	| { futureExecutionId: string; expectedPayloadJson: string }
);

export function createProcessTitleJobRepo(db: LeitwerkDb) {
	function transition(
		id: string,
		from: ProcessTitleJob["status"][],
		values: SQLiteUpdateSetSource<typeof s.processTitleJobs>,
	): ProcessTitleJob | null {
		return (
			db
				.update(s.processTitleJobs)
				.set({ ...values, updatedAt: now() })
				.where(and(eq(s.processTitleJobs.id, id), inArray(s.processTitleJobs.status, from)))
				.returning()
				.get() ?? null
		);
	}

	return {
		enqueue(input: EnqueueProcessTitleJobInput): ProcessTitleJob {
			const ts = now();
			const target =
				"processInstanceId" in input
					? {
							targetKind: "process" as const,
							processInstanceId: input.processInstanceId,
							launchRunId: input.launchRunId ?? null,
						}
					: {
							targetKind: "future_execution" as const,
							futureExecutionId: input.futureExecutionId,
							expectedPayloadJson: input.expectedPayloadJson,
						};
			db.update(s.processTitleJobs)
				.set({ status: "superseded", updatedAt: ts })
				.where(
					and(
						inArray(s.processTitleJobs.status, ["pending", "running"]),
						target.targetKind === "process"
							? eq(s.processTitleJobs.processInstanceId, target.processInstanceId)
							: eq(s.processTitleJobs.futureExecutionId, target.futureExecutionId),
					),
				)
				.run();
			return db
				.insert(s.processTitleJobs)
				.values({
					...target,
					id: generateId("ttj"),
					processDefinitionId: input.processDefinitionId,
					modelProfileId: input.modelProfileId,
					prompt: input.prompt,
					status: "pending",
					maxAttempts: input.maxAttempts,
					nextRunAt: input.nextRunAt,
					createdAt: ts,
					updatedAt: ts,
				})
				.returning()
				.get();
		},

		getById(id: string): ProcessTitleJob | null {
			const row = db.select().from(s.processTitleJobs).where(eq(s.processTitleJobs.id, id)).get();
			return row ?? null;
		},

		listByProcessInstance(processInstanceId: string): ProcessTitleJob[] {
			return db
				.select()
				.from(s.processTitleJobs)
				.where(eq(s.processTitleJobs.processInstanceId, processInstanceId))
				.orderBy(asc(s.processTitleJobs.createdAt), asc(s.processTitleJobs.id))
				.all();
		},

		listAll(): ProcessTitleJob[] {
			return db
				.select()
				.from(s.processTitleJobs)
				.orderBy(asc(s.processTitleJobs.createdAt), asc(s.processTitleJobs.id))
				.all();
		},

		listDuePending(asOf: string, limit: number): ProcessTitleJob[] {
			return db
				.select()
				.from(s.processTitleJobs)
				.where(
					and(eq(s.processTitleJobs.status, "pending"), lte(s.processTitleJobs.nextRunAt, asOf)),
				)
				.orderBy(asc(s.processTitleJobs.nextRunAt), asc(s.processTitleJobs.createdAt))
				.limit(Math.max(0, limit))
				.all();
		},

		markRunning(id: string): ProcessTitleJob | null {
			return transition(id, ["pending"], {
				status: "running",
				attemptCount: sql`${s.processTitleJobs.attemptCount} + 1`,
				lastError: null,
			});
		},

		reschedule(id: string, nextRunAt: string, lastError: string): ProcessTitleJob | null {
			return transition(id, ["running"], { status: "pending", nextRunAt, lastError });
		},

		markCompleted(id: string): ProcessTitleJob | null {
			return transition(id, ["running"], { status: "completed", lastError: null });
		},

		markFailed(id: string, lastError: string): ProcessTitleJob | null {
			return transition(id, ["running"], { status: "failed", lastError });
		},

		markSuperseded(id: string): ProcessTitleJob | null {
			return transition(id, ["pending", "running"], { status: "superseded" });
		},
	};
}
