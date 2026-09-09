import {
	type CurrentExecutionRef,
	isProcessSelectedTurnModelSource,
	type ModelSelectionKind,
	type ProcessCustomizableFields,
	type ProcessInstance,
	type ProcessLifecycleStatus,
	type ProcessSelectedTurnModelSource,
	type TurnId,
} from "@leitwerk-dev/domain";
import { and, asc, count, desc, eq, inArray, notInArray, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { normalizeProcessTitleInput } from "../launch-title.js";
import type { LeitwerkDb } from "./database.js";
import { generateId, now, sqliteLikePatterns } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface ProcessLaunchIntent {
	launcherId: string;
	launcherInput: Record<string, unknown>;
}

export interface CreateProcessInstanceInput extends ProcessCustomizableFields {
	processId: string;
	selectedTurnId?: TurnId | null;
	lifecycleStatus?: ProcessLifecycleStatus;
	currentExecution?: CurrentExecutionRef;
	selectedTurnModelKind?: ModelSelectionKind | null;
	selectedTurnModelSource?: ProcessSelectedTurnModelSource | null;
	paramsJson?: string | null;
	stateJson?: string | null;
	launchIntent?: ProcessLaunchIntent;
}

export type ProcessOverviewStatusFilter =
	| "all"
	| "running"
	| "needs_attention"
	| "completed"
	| "aborted"
	| "scheduled";

export interface ProcessOverviewQuery {
	query?: string;
	processType?: string;
	status?: ProcessOverviewStatusFilter;
}

export interface ProcessOverviewWindowQuery extends ProcessOverviewQuery {
	limit: number;
	sortKey: "status" | "title" | "timeline";
	sortDirection: "asc" | "desc";
}

export interface UpdateProcessInstanceInput extends ProcessCustomizableFields {
	selectedTurnId?: TurnId | null;
	lifecycleStatus?: ProcessLifecycleStatus;
	currentExecution?: CurrentExecutionRef;
	planRevision?: number;
	selectedTurnModelKind?: ModelSelectionKind | null;
	selectedTurnModelSource?: ProcessSelectedTurnModelSource | null;
	paramsJson?: string | null;
	stateJson?: string | null;
}

function isTerminalLifecycleStatus(status: ProcessLifecycleStatus | null | undefined): boolean {
	return status === "completed" || status === "aborted";
}

function overviewPredicates(input: ProcessOverviewQuery): SQL[] {
	const predicates: SQL[] = [];
	const processType = input.processType?.trim();
	if (processType) {
		predicates.push(eq(s.processInstances.processId, processType));
	}
	switch (input.status ?? "all") {
		case "running":
			predicates.push(inArray(s.processInstances.lifecycleStatus, ["discovered", "active"]));
			break;
		case "needs_attention":
			predicates.push(inArray(s.processInstances.lifecycleStatus, ["waiting", "error"]));
			break;
		case "completed":
			predicates.push(eq(s.processInstances.lifecycleStatus, "completed"));
			break;
		case "aborted":
			predicates.push(eq(s.processInstances.lifecycleStatus, "aborted"));
			break;
		case "scheduled":
			// Scheduled rows are future executions, not process instances.
			predicates.push(sql`0 = 1`);
			break;
		case "all":
			break;
	}
	for (const pattern of sqliteLikePatterns(input.query)) {
		predicates.push(
			or(
				sql`lower(coalesce(${s.processInstances.title}, '')) LIKE ${pattern} ESCAPE '\\'`,
				sql`lower(coalesce(${s.processInstances.externalId}, '')) LIKE ${pattern} ESCAPE '\\'`,
				sql`lower(${s.processInstances.id}) LIKE ${pattern} ESCAPE '\\'`,
				sql`lower(coalesce(${s.processInstances.paramsJson}, '')) LIKE ${pattern} ESCAPE '\\'`,
			) as SQL,
		);
	}
	return predicates;
}

function overviewWhere(input: ProcessOverviewQuery): SQL | undefined {
	const predicates = overviewPredicates(input);
	return predicates.length ? and(...predicates) : undefined;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function parseLaunchIntent(raw: string | null): ProcessLaunchIntent | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<ProcessLaunchIntent>;
		return typeof value.launcherId === "string" &&
			typeof value.launcherInput === "object" &&
			value.launcherInput !== null &&
			!Array.isArray(value.launcherInput)
			? (value as ProcessLaunchIntent)
			: null;
	} catch {
		return null;
	}
}

function rowToProcessInstance(row: typeof s.processInstances.$inferSelect): ProcessInstance {
	return {
		id: row.id,
		processId: row.processId,
		selectedTurnId: row.selectedTurnId ?? null,
		lifecycleStatus: (row.lifecycleStatus as ProcessLifecycleStatus) ?? "discovered",
		currentExecution: row.currentWorkerStartId
			? { kind: "worker_start", id: row.currentWorkerStartId }
			: null,
		planRevision: row.planRevision,
		title: row.title ?? null,
		externalId: row.externalId ?? null,
		externalUrl: row.externalUrl ?? null,
		metadata: parseMetadata(row.metadata),
		defaultModelProfileId: row.defaultModelProfileId ?? null,
		initialDefaultModelProfileId: row.initialDefaultModelProfileId ?? null,
		turnConfigsJson: row.turnConfigsJson ?? null,
		selectedTurnModelProfileId: row.selectedTurnModelProfileId ?? null,
		selectedTurnModelKind:
			row.selectedTurnModelKind === "explicit" || row.selectedTurnModelKind === "inherited"
				? row.selectedTurnModelKind
				: null,
		selectedTurnModelSource: isProcessSelectedTurnModelSource(row.selectedTurnModelSource)
			? row.selectedTurnModelSource
			: null,
		paramsJson: row.paramsJson ?? null,
		stateJson: row.stateJson ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		closedAt: row.closedAt ?? null,
	};
}

export function createProcessInstanceRepo(db: LeitwerkDb) {
	return {
		getLaunchIntent(instanceId: string): ProcessLaunchIntent | null {
			const row = db
				.select({ launchIntentJson: s.processInstances.launchIntentJson })
				.from(s.processInstances)
				.where(eq(s.processInstances.id, instanceId))
				.get();
			return parseLaunchIntent(row?.launchIntentJson ?? null);
		},
		create(input: CreateProcessInstanceInput): ProcessInstance {
			const id = generateId("agt");
			const ts = now();
			const lifecycleStatus = input.lifecycleStatus ?? "discovered";
			const values = {
				id,
				processId: input.processId,
				selectedTurnId: input.selectedTurnId ?? null,
				lifecycleStatus,
				currentWorkerStartId:
					input.currentExecution?.kind === "worker_start" ? input.currentExecution.id : null,
				planRevision: 0,
				title: normalizeProcessTitleInput(input.title),
				externalId: input.externalId ?? null,
				externalUrl: input.externalUrl ?? null,
				metadata: input.metadata ? JSON.stringify(input.metadata) : null,
				defaultModelProfileId: input.defaultModelProfileId ?? null,
				initialDefaultModelProfileId: input.initialDefaultModelProfileId ?? null,
				turnConfigsJson: input.turnConfigsJson ?? null,
				selectedTurnModelProfileId: input.selectedTurnModelProfileId ?? null,
				selectedTurnModelKind: input.selectedTurnModelKind ?? null,
				selectedTurnModelSource: input.selectedTurnModelSource ?? null,
				paramsJson: input.paramsJson ?? null,
				stateJson: input.stateJson ?? null,
				launchIntentJson: input.launchIntent ? JSON.stringify(input.launchIntent) : null,
				createdAt: ts,
				updatedAt: ts,
				closedAt: isTerminalLifecycleStatus(lifecycleStatus) ? ts : null,
			};
			db.insert(s.processInstances).values(values).run();
			return rowToProcessInstance({ ...values, planRevision: 0 });
		},

		getById(id: string): ProcessInstance | null {
			const row = db.select().from(s.processInstances).where(eq(s.processInstances.id, id)).get();
			return row ? rowToProcessInstance(row) : null;
		},

		listAll(): ProcessInstance[] {
			return db
				.select()
				.from(s.processInstances)
				.orderBy(desc(s.processInstances.updatedAt))
				.all()
				.map(rowToProcessInstance);
		},

		listCurrent(limit: number): ProcessInstance[] {
			return db
				.select()
				.from(s.processInstances)
				.where(notInArray(s.processInstances.lifecycleStatus, ["completed", "aborted"]))
				.orderBy(desc(s.processInstances.updatedAt), asc(s.processInstances.id))
				.limit(limit)
				.all()
				.map(rowToProcessInstance);
		},

		countCurrent(): number {
			return (
				db
					.select({ value: count() })
					.from(s.processInstances)
					.where(notInArray(s.processInstances.lifecycleStatus, ["completed", "aborted"]))
					.get()?.value ?? 0
			);
		},

		countOverview(input: ProcessOverviewQuery): number {
			return (
				db.select({ value: count() }).from(s.processInstances).where(overviewWhere(input)).get()
					?.value ?? 0
			);
		},

		countOverviewByLifecycle(input: Pick<ProcessOverviewQuery, "query" | "processType">) {
			return db
				.select({ lifecycleStatus: s.processInstances.lifecycleStatus, value: count() })
				.from(s.processInstances)
				.where(overviewWhere({ ...input, status: "all" }))
				.groupBy(s.processInstances.lifecycleStatus)
				.all();
		},

		listOverviewProcessTypes(input: Pick<ProcessOverviewQuery, "query" | "status">) {
			return db
				.select({ processId: s.processInstances.processId, value: count() })
				.from(s.processInstances)
				.where(overviewWhere(input))
				.groupBy(s.processInstances.processId)
				.orderBy(asc(s.processInstances.processId))
				.all();
		},

		listOverviewWindow(input: ProcessOverviewWindowQuery): ProcessInstance[] {
			const title = sql<string>`coalesce(${s.processInstances.title}, ${s.processInstances.externalId}, ${s.processInstances.id})`;
			const status = sql<number>`case
				when ${s.processInstances.lifecycleStatus} in ('waiting', 'error') then 0
				when ${s.processInstances.lifecycleStatus} in ('discovered', 'active') then 1
				when ${s.processInstances.lifecycleStatus} = 'completed' then 3
				else 4 end`;
			const timeline = sql<string>`case
				when ${s.processInstances.lifecycleStatus} in ('completed', 'aborted')
					then coalesce(${s.processInstances.closedAt}, ${s.processInstances.updatedAt})
				else ${s.processInstances.updatedAt} end`;
			const primary =
				input.sortKey === "status" ? status : input.sortKey === "title" ? title : timeline;
			return db
				.select()
				.from(s.processInstances)
				.where(overviewWhere(input))
				.orderBy(
					input.sortDirection === "desc" ? desc(primary) : asc(primary),
					asc(title),
					asc(s.processInstances.id),
				)
				.limit(input.limit)
				.all()
				.map(rowToProcessInstance);
		},

		setGeneratedTitleIfBlank(id: string, title: string): ProcessInstance | null {
			const normalizedTitle = normalizeProcessTitleInput(title);
			if (!normalizedTitle) {
				return null;
			}
			const result = db
				.update(s.processInstances)
				.set({ title: normalizedTitle, updatedAt: now() })
				.where(
					and(
						eq(s.processInstances.id, id),
						sql`trim(coalesce(${s.processInstances.title}, '')) = ''`,
					),
				)
				.run();
			return result.changes > 0 ? this.getById(id) : null;
		},

		update(id: string, input: UpdateProcessInstanceInput): ProcessInstance | null {
			const ts = now();
			const setValues: SQLiteUpdateSetSource<typeof s.processInstances> = {
				updatedAt: ts,
				defaultModelProfileId: input.defaultModelProfileId,
				initialDefaultModelProfileId: input.initialDefaultModelProfileId,
				selectedTurnId: input.selectedTurnId,
				lifecycleStatus: input.lifecycleStatus,
				planRevision: input.planRevision,
				externalId: input.externalId,
				externalUrl: input.externalUrl,
				turnConfigsJson: input.turnConfigsJson,
				selectedTurnModelProfileId: input.selectedTurnModelProfileId,
				selectedTurnModelKind: input.selectedTurnModelKind,
				selectedTurnModelSource: input.selectedTurnModelSource,
				paramsJson: input.paramsJson,
				stateJson: input.stateJson,
			};
			if (input.currentExecution !== undefined) {
				setValues.currentWorkerStartId =
					input.currentExecution?.kind === "worker_start" ? input.currentExecution.id : null;
			}
			if (input.title !== undefined) setValues.title = normalizeProcessTitleInput(input.title);
			if (input.metadata !== undefined)
				setValues.metadata = input.metadata ? JSON.stringify(input.metadata) : null;
			if (isTerminalLifecycleStatus(input.lifecycleStatus)) {
				setValues.closedAt = sql`coalesce(${s.processInstances.closedAt}, ${ts})`;
			}

			db.update(s.processInstances).set(setValues).where(eq(s.processInstances.id, id)).run();
			return this.getById(id);
		},

		delete(id: string): boolean {
			const result = db.delete(s.processInstances).where(eq(s.processInstances.id, id)).run();
			return result.changes > 0;
		},
	};
}
