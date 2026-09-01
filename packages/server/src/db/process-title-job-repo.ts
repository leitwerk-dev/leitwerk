import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export type ProcessTitleJobTargetKind = "process" | "future_execution";
export type ProcessTitleJobStatus = "pending" | "running" | "completed" | "superseded" | "failed";

export interface ProcessTitleJob {
	id: string;
	targetKind: ProcessTitleJobTargetKind;
	processDefinitionId: string;
	processInstanceId: string | null;
	futureExecutionId: string | null;
	launchRunId: string | null;
	modelProfileId: string;
	prompt: string;
	expectedPayloadJson: string | null;
	status: ProcessTitleJobStatus;
	attemptCount: number;
	maxAttempts: number;
	nextRunAt: string;
	lastError: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface EnqueueProcessTitleJobInput {
	processInstanceId: string;
	processDefinitionId: string;
	launchRunId?: string | null;
	modelProfileId: string;
	prompt: string;
	maxAttempts: number;
	nextRunAt: string;
}

export interface EnqueueFutureExecutionTitleJobInput {
	futureExecutionId: string;
	processDefinitionId: string;
	modelProfileId: string;
	prompt: string;
	expectedPayloadJson: string;
	maxAttempts: number;
	nextRunAt: string;
}

function rowToProcessTitleJob(row: typeof s.processTitleJobs.$inferSelect): ProcessTitleJob {
	return {
		id: row.id,
		targetKind: row.targetKind as ProcessTitleJobTargetKind,
		processDefinitionId: row.processDefinitionId,
		processInstanceId: row.processInstanceId ?? null,
		futureExecutionId: row.futureExecutionId ?? null,
		launchRunId: row.launchRunId ?? null,
		modelProfileId: row.modelProfileId,
		prompt: row.prompt,
		expectedPayloadJson: row.expectedPayloadJson ?? null,
		status: row.status as ProcessTitleJobStatus,
		attemptCount: row.attemptCount,
		maxAttempts: row.maxAttempts,
		nextRunAt: row.nextRunAt,
		lastError: row.lastError ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function createProcessTitleJobRepo(db: LeitwerkDb) {
	return {
		enqueueProcessJob(input: EnqueueProcessTitleJobInput): ProcessTitleJob {
			const ts = now();
			this.supersedeActiveForProcessInstance(input.processInstanceId);
			const values = {
				id: generateId("ttj"),
				targetKind: "process",
				processDefinitionId: input.processDefinitionId,
				processInstanceId: input.processInstanceId,
				futureExecutionId: null,
				launchRunId: input.launchRunId ?? null,
				modelProfileId: input.modelProfileId,
				prompt: input.prompt,
				expectedPayloadJson: null,
				status: "pending",
				attemptCount: 0,
				maxAttempts: input.maxAttempts,
				nextRunAt: input.nextRunAt,
				lastError: null,
				createdAt: ts,
				updatedAt: ts,
			} satisfies typeof s.processTitleJobs.$inferInsert;
			db.insert(s.processTitleJobs).values(values).run();
			return rowToProcessTitleJob(values);
		},

		enqueueFutureExecutionJob(input: EnqueueFutureExecutionTitleJobInput): ProcessTitleJob {
			const ts = now();
			this.supersedeActiveForFutureExecution(input.futureExecutionId);
			const values = {
				id: generateId("ttj"),
				targetKind: "future_execution",
				processDefinitionId: input.processDefinitionId,
				processInstanceId: null,
				futureExecutionId: input.futureExecutionId,
				launchRunId: null,
				modelProfileId: input.modelProfileId,
				prompt: input.prompt,
				expectedPayloadJson: input.expectedPayloadJson,
				status: "pending",
				attemptCount: 0,
				maxAttempts: input.maxAttempts,
				nextRunAt: input.nextRunAt,
				lastError: null,
				createdAt: ts,
				updatedAt: ts,
			} satisfies typeof s.processTitleJobs.$inferInsert;
			db.insert(s.processTitleJobs).values(values).run();
			return rowToProcessTitleJob(values);
		},

		getById(id: string): ProcessTitleJob | null {
			const row = db.select().from(s.processTitleJobs).where(eq(s.processTitleJobs.id, id)).get();
			return row ? rowToProcessTitleJob(row) : null;
		},

		listByProcessInstance(processInstanceId: string): ProcessTitleJob[] {
			return db
				.select()
				.from(s.processTitleJobs)
				.where(eq(s.processTitleJobs.processInstanceId, processInstanceId))
				.orderBy(asc(s.processTitleJobs.createdAt), asc(s.processTitleJobs.id))
				.all()
				.map(rowToProcessTitleJob);
		},

		listAll(): ProcessTitleJob[] {
			return db
				.select()
				.from(s.processTitleJobs)
				.orderBy(asc(s.processTitleJobs.createdAt), asc(s.processTitleJobs.id))
				.all()
				.map(rowToProcessTitleJob);
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
				.all()
				.map(rowToProcessTitleJob);
		},

		listByFutureExecution(futureExecutionId: string): ProcessTitleJob[] {
			return db
				.select()
				.from(s.processTitleJobs)
				.where(eq(s.processTitleJobs.futureExecutionId, futureExecutionId))
				.orderBy(asc(s.processTitleJobs.createdAt), asc(s.processTitleJobs.id))
				.all()
				.map(rowToProcessTitleJob);
		},

		markRunning(id: string): ProcessTitleJob | null {
			const current = this.getById(id);
			if (!current || current.status !== "pending") {
				return null;
			}
			const ts = now();
			const runningResult = db
				.update(s.processTitleJobs)
				.set({
					status: "running",
					attemptCount: current.attemptCount + 1,
					lastError: null,
					updatedAt: ts,
				})
				.where(and(eq(s.processTitleJobs.id, id), eq(s.processTitleJobs.status, "pending")))
				.run();
			return runningResult.changes > 0 ? this.getById(id) : null;
		},

		reschedule(id: string, nextRunAt: string, lastError: string): ProcessTitleJob | null {
			const result = db
				.update(s.processTitleJobs)
				.set({
					status: "pending",
					nextRunAt,
					lastError,
					updatedAt: now(),
				})
				.where(and(eq(s.processTitleJobs.id, id), eq(s.processTitleJobs.status, "running")))
				.run();
			return result.changes > 0 ? this.getById(id) : null;
		},

		markCompleted(id: string): ProcessTitleJob | null {
			const result = db
				.update(s.processTitleJobs)
				.set({ status: "completed", lastError: null, updatedAt: now() })
				.where(and(eq(s.processTitleJobs.id, id), eq(s.processTitleJobs.status, "running")))
				.run();
			return result.changes > 0 ? this.getById(id) : null;
		},

		markFailed(id: string, lastError: string): ProcessTitleJob | null {
			const result = db
				.update(s.processTitleJobs)
				.set({ status: "failed", lastError, updatedAt: now() })
				.where(and(eq(s.processTitleJobs.id, id), eq(s.processTitleJobs.status, "running")))
				.run();
			return result.changes > 0 ? this.getById(id) : null;
		},

		markSuperseded(id: string): ProcessTitleJob | null {
			const result = db
				.update(s.processTitleJobs)
				.set({ status: "superseded", updatedAt: now() })
				.where(
					and(
						eq(s.processTitleJobs.id, id),
						inArray(s.processTitleJobs.status, ["pending", "running"]),
					),
				)
				.run();
			return result.changes > 0 ? this.getById(id) : null;
		},

		supersedeActiveForProcessInstance(processInstanceId: string): number {
			const result = db
				.update(s.processTitleJobs)
				.set({ status: "superseded", updatedAt: now() })
				.where(
					and(
						eq(s.processTitleJobs.processInstanceId, processInstanceId),
						inArray(s.processTitleJobs.status, ["pending", "running"]),
					),
				)
				.run();
			return Number(result.changes);
		},

		supersedeActiveForFutureExecution(futureExecutionId: string): number {
			const result = db
				.update(s.processTitleJobs)
				.set({ status: "superseded", updatedAt: now() })
				.where(
					and(
						eq(s.processTitleJobs.futureExecutionId, futureExecutionId),
						inArray(s.processTitleJobs.status, ["pending", "running"]),
					),
				)
				.run();
			return Number(result.changes);
		},
	};
}
