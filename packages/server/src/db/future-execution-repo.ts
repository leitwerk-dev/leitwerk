import type {
	DurableModelSelection,
	FutureExecution,
	FutureExecutionBlockReason,
	FutureExecutionKind,
	FutureExecutionScheduleKind,
} from "@leitwerk-dev/domain";
import { and, asc, count, desc, eq, inArray, lte, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { LeitwerkDb } from "./database.js";
import { generateId, now, sqliteLikePatterns } from "./repo-helpers.js";
import * as s from "./schema.js";

interface FutureExecutionWritableFields {
	scheduleKind: FutureExecutionScheduleKind;
	processId: string;
	instanceId?: string | null;
	launcherId?: string | null;
	actionId?: string | null;
	payloadJson: string;
	cronExpression?: string | null;
	nextRunAt: string;
	modelSelection?: DurableModelSelection | null;
	blockedReason?: FutureExecutionBlockReason | null;
}

export interface CreateFutureExecutionInput extends FutureExecutionWritableFields {
	id?: string;
	kind: FutureExecutionKind;
}

export interface FutureExecutionOverviewQuery {
	query?: string;
	processType?: string;
	status?: "all" | "running" | "scheduled" | "needs_attention" | "completed" | "aborted";
	matchingLauncherIdsByTerm?: readonly (readonly string[])[];
}

export interface FutureExecutionOverviewPageQuery extends FutureExecutionOverviewQuery {
	limit: number;
	offset: number;
}

export interface FutureExecutionOverviewWindowQuery extends FutureExecutionOverviewQuery {
	limit: number;
	sortKey: "status" | "title" | "timeline";
	sortDirection: "asc" | "desc";
	launcherFallbackTitles: Readonly<Record<string, string>>;
}

export type UpdateFutureExecutionInput = Partial<FutureExecutionWritableFields>;

function overviewPredicates(input: FutureExecutionOverviewQuery): SQL[] {
	// Scheduled actions already have a durable process row; only scheduled launches
	// are separate browse records.
	const predicates: SQL[] = [eq(s.futureExecutions.kind, "launch")];
	if (input.status === "needs_attention") {
		predicates.push(sql`${s.futureExecutions.blockedReasonJson} is not null`);
	} else if (input.status === "scheduled") {
		predicates.push(sql`${s.futureExecutions.blockedReasonJson} is null`);
	} else if (input.status && input.status !== "all") {
		predicates.push(sql`0 = 1`);
	}
	const processType = input.processType?.trim();
	if (processType) {
		predicates.push(eq(s.futureExecutions.processId, processType));
	}
	for (const [index, pattern] of sqliteLikePatterns(input.query).entries()) {
		const matchingLauncherIds = input.matchingLauncherIdsByTerm?.[index] ?? [];
		const launcherMatch =
			matchingLauncherIds.length > 0
				? inArray(s.futureExecutions.launcherId, [...matchingLauncherIds])
				: sql`0 = 1`;
		predicates.push(
			or(
				sql`lower(${s.futureExecutions.payloadJson}) LIKE ${pattern} ESCAPE '\\'`,
				sql`lower(${s.futureExecutions.processId}) LIKE ${pattern} ESCAPE '\\'`,
				sql`lower(coalesce(${s.futureExecutions.id}, '')) LIKE ${pattern} ESCAPE '\\'`,
				launcherMatch,
			) as SQL,
		);
	}
	return predicates;
}

function overviewWhere(input: FutureExecutionOverviewQuery): SQL | undefined {
	const predicates = overviewPredicates(input);
	return predicates.length ? and(...predicates) : undefined;
}

function parseBlockReason(value: string | null): FutureExecutionBlockReason | null {
	if (!value) return null;
	const parsed = JSON.parse(value) as FutureExecutionBlockReason;
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof parsed.code !== "string" ||
		typeof parsed.summary !== "string" ||
		typeof parsed.detectedAt !== "string" ||
		(parsed.availabilityRevision !== undefined && typeof parsed.availabilityRevision !== "number")
	) {
		throw new Error("Invalid persisted future execution block reason");
	}
	return parsed;
}

function selectionFromRow(
	row: typeof s.futureExecutions.$inferSelect,
): DurableModelSelection | null {
	const values = [row.modelProfileId, row.modelSelectionKind, row.modelSelectionSource];
	if (values.every((value) => value === null)) return null;
	if (
		typeof row.modelProfileId !== "string" ||
		(row.modelSelectionKind !== "explicit" && row.modelSelectionKind !== "inherited") ||
		typeof row.modelSelectionSource !== "string"
	) {
		throw new Error(`Incomplete model selection provenance for future execution '${row.id}'`);
	}
	return {
		modelProfileId: row.modelProfileId,
		provenance: {
			kind: row.modelSelectionKind,
			source: row.modelSelectionSource as DurableModelSelection["provenance"]["source"],
		},
	};
}

function modelSelectionColumns(selection: DurableModelSelection | null | undefined) {
	return {
		modelProfileId: selection?.modelProfileId ?? null,
		modelSelectionKind: selection?.provenance.kind ?? null,
		modelSelectionSource: selection?.provenance.source ?? null,
	};
}

function rowToFutureExecution(row: typeof s.futureExecutions.$inferSelect): FutureExecution {
	return {
		id: row.id,
		kind: row.kind as FutureExecutionKind,
		scheduleKind: row.scheduleKind as FutureExecutionScheduleKind,
		processId: row.processId,
		instanceId: row.instanceId ?? null,
		launcherId: row.launcherId ?? null,
		actionId: row.actionId ?? null,
		payloadJson: row.payloadJson,
		cronExpression: row.cronExpression ?? null,
		nextRunAt: row.nextRunAt,
		modelSelection: selectionFromRow(row),
		blockedReason: parseBlockReason(row.blockedReasonJson),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function createFutureExecutionRepo(db: LeitwerkDb) {
	return {
		create(input: CreateFutureExecutionInput): FutureExecution {
			const id = input.id ?? generateId("fut");
			const ts = now();
			const values = {
				id,
				kind: input.kind,
				scheduleKind: input.scheduleKind,
				processId: input.processId,
				instanceId: input.instanceId ?? null,
				launcherId: input.launcherId ?? null,
				actionId: input.actionId ?? null,
				payloadJson: input.payloadJson,
				cronExpression: input.cronExpression ?? null,
				nextRunAt: input.nextRunAt,
				createdAt: ts,
				updatedAt: ts,
				...modelSelectionColumns(input.modelSelection),
				blockedReasonJson: input.blockedReason ? JSON.stringify(input.blockedReason) : null,
			};
			db.insert(s.futureExecutions).values(values).run();
			return rowToFutureExecution(values);
		},

		getById(id: string): FutureExecution | null {
			const row = db.select().from(s.futureExecutions).where(eq(s.futureExecutions.id, id)).get();
			return row ? rowToFutureExecution(row) : null;
		},

		listAll(): FutureExecution[] {
			return db
				.select()
				.from(s.futureExecutions)
				.orderBy(asc(s.futureExecutions.nextRunAt), asc(s.futureExecutions.createdAt))
				.all()
				.map(rowToFutureExecution);
		},

		countOverview(input: FutureExecutionOverviewQuery): number {
			return (
				db.select({ value: count() }).from(s.futureExecutions).where(overviewWhere(input)).get()
					?.value ?? 0
			);
		},

		listOverviewProcessTypes(
			input: Pick<FutureExecutionOverviewQuery, "query" | "status" | "matchingLauncherIdsByTerm">,
		) {
			return db
				.select({ processId: s.futureExecutions.processId, value: count() })
				.from(s.futureExecutions)
				.where(overviewWhere(input))
				.groupBy(s.futureExecutions.processId)
				.orderBy(asc(s.futureExecutions.processId))
				.all();
		},

		listOverviewWindow(input: FutureExecutionOverviewWindowQuery): FutureExecution[] {
			const fallbackCases = Object.entries(input.launcherFallbackTitles).map(
				([launcherId, title]) => sql`when ${launcherId} then ${title}`,
			);
			const unknownLauncherFallback = sql<string>`case
				when json_valid(${s.futureExecutions.payloadJson}) then ${s.futureExecutions.processId}
				else coalesce(${s.futureExecutions.launcherId}, ${s.futureExecutions.processId}) end`;
			const launcherFallback =
				fallbackCases.length > 0
					? sql<string>`case ${s.futureExecutions.launcherId} ${sql.join(fallbackCases, sql.raw(" "))} else ${unknownLauncherFallback} end`
					: unknownLauncherFallback;
			const title = sql<string>`coalesce(
				case when json_valid(${s.futureExecutions.payloadJson})
					then nullif(trim(json_extract(${s.futureExecutions.payloadJson}, '$.launchPlan.processInput.title')), '') end,
				case when json_valid(${s.futureExecutions.payloadJson})
					then nullif(trim(json_extract(${s.futureExecutions.payloadJson}, '$.launchPlan.processInput.externalId')), '') end,
				${launcherFallback}
			)`;
			const primary = input.sortKey === "timeline" ? s.futureExecutions.nextRunAt : title;
			return db
				.select()
				.from(s.futureExecutions)
				.where(overviewWhere(input))
				.orderBy(
					input.sortKey !== "status" && input.sortDirection === "desc"
						? desc(primary)
						: asc(primary),
					asc(title),
					asc(s.futureExecutions.id),
				)
				.limit(input.limit)
				.all()
				.map(rowToFutureExecution);
		},

		listOverviewPage(input: FutureExecutionOverviewPageQuery): {
			items: FutureExecution[];
			total: number;
		} {
			const items = db
				.select()
				.from(s.futureExecutions)
				.where(overviewWhere(input))
				.orderBy(asc(s.futureExecutions.nextRunAt), asc(s.futureExecutions.createdAt))
				.limit(input.limit)
				.offset(input.offset)
				.all()
				.map(rowToFutureExecution);
			const total = this.countOverview(input);
			return { items, total };
		},

		listByInstance(instanceId: string): FutureExecution[] {
			return db
				.select()
				.from(s.futureExecutions)
				.where(eq(s.futureExecutions.instanceId, instanceId))
				.orderBy(asc(s.futureExecutions.nextRunAt), asc(s.futureExecutions.createdAt))
				.all()
				.map(rowToFutureExecution);
		},

		listRunnableDue(asOf: string): FutureExecution[] {
			return db
				.select()
				.from(s.futureExecutions)
				.where(
					and(
						lte(s.futureExecutions.nextRunAt, asOf),
						sql`${s.futureExecutions.blockedReasonJson} is null`,
					),
				)
				.orderBy(asc(s.futureExecutions.nextRunAt), asc(s.futureExecutions.createdAt))
				.all()
				.map(rowToFutureExecution);
		},

		listBlockedCronDue(asOf: string): FutureExecution[] {
			return db
				.select()
				.from(s.futureExecutions)
				.where(
					and(
						lte(s.futureExecutions.nextRunAt, asOf),
						eq(s.futureExecutions.scheduleKind, "cron"),
						sql`${s.futureExecutions.blockedReasonJson} is not null`,
					),
				)
				.orderBy(asc(s.futureExecutions.nextRunAt), asc(s.futureExecutions.createdAt))
				.all()
				.map(rowToFutureExecution);
		},

		getScheduledActionByInstance(instanceId: string): FutureExecution | null {
			const row = db
				.select()
				.from(s.futureExecutions)
				.where(
					and(eq(s.futureExecutions.instanceId, instanceId), eq(s.futureExecutions.kind, "action")),
				)
				.orderBy(asc(s.futureExecutions.nextRunAt), asc(s.futureExecutions.createdAt))
				.get();
			return row ? rowToFutureExecution(row) : null;
		},

		updatePayloadJsonIfUnchanged(
			id: string,
			expectedPayloadJson: string,
			payloadJson: string,
		): FutureExecution | null {
			const result = db
				.update(s.futureExecutions)
				.set({ payloadJson, updatedAt: now() })
				.where(
					and(
						eq(s.futureExecutions.id, id),
						eq(s.futureExecutions.payloadJson, expectedPayloadJson),
					),
				)
				.run();
			return result.changes > 0 ? this.getById(id) : null;
		},

		update(id: string, input: UpdateFutureExecutionInput): FutureExecution | null {
			const setValues: SQLiteUpdateSetSource<typeof s.futureExecutions> = {
				updatedAt: now(),
				scheduleKind: input.scheduleKind,
				processId: input.processId,
				instanceId: input.instanceId,
				launcherId: input.launcherId,
				actionId: input.actionId,
				payloadJson: input.payloadJson,
				cronExpression: input.cronExpression,
				nextRunAt: input.nextRunAt,
			};
			if (input.modelSelection !== undefined)
				Object.assign(setValues, modelSelectionColumns(input.modelSelection));
			if (input.blockedReason !== undefined)
				setValues.blockedReasonJson = input.blockedReason
					? JSON.stringify(input.blockedReason)
					: null;

			db.update(s.futureExecutions).set(setValues).where(eq(s.futureExecutions.id, id)).run();
			return this.getById(id);
		},

		delete(id: string): boolean {
			const result = db.delete(s.futureExecutions).where(eq(s.futureExecutions.id, id)).run();
			return result.changes > 0;
		},
	};
}
