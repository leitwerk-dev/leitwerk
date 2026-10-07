import {
	assertRepoLocator,
	detectRepoLocatorKind,
	type ProcessProject,
} from "@leitwerk-dev/domain";
import { and, eq, inArray } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import type { LeitwerkDb } from "./database.js";
import { generateId, now, parseMetadata } from "./repo-helpers.js";
import * as s from "./schema.js";

/** @internal */
export interface CreateProcessProjectInput extends UpdateProcessProjectInput {
	/** @internal */
	instanceId: string;
	/** @internal */
	key: string;
	/** @internal */
	repoLocator: string;
	/** @internal */
	baseBranch: string;
}

/** @public */
export interface UpdateProcessProjectInput {
	/** @internal */
	repoLocator?: string;
	/** @internal */
	workBranch?: string | null;
	/** @internal */
	externalId?: string | null;
	/** @internal */
	externalUrl?: string | null;
	/** @public */
	metadata?: Record<string, unknown> | null;
	/** @internal */
	pipelineStatus?: string | null;
	/** @internal */
	baseBranch?: string;
}

function rowToProcessProject(row: typeof s.processProjects.$inferSelect): ProcessProject {
	return {
		id: row.id,
		instanceId: row.instanceId,
		key: row.key,
		repoLocator: row.repoLocator,
		repoLocatorKind: row.repoLocatorKind as ProcessProject["repoLocatorKind"],
		baseBranch: row.baseBranch,
		workBranch: row.workBranch,
		externalId: row.externalId ?? null,
		externalUrl: row.externalUrl ?? null,
		metadata: parseMetadata(row.metadata),
		pipelineStatus: row.pipelineStatus,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** @public */
export function createProcessProjectRepo(db: LeitwerkDb) {
	return {
		/** @internal */
		create(input: CreateProcessProjectInput): ProcessProject {
			const id = generateId("prj");
			const ts = now();
			const repoLocator = assertRepoLocator(input.repoLocator);
			const repoLocatorKind = detectRepoLocatorKind(repoLocator) ?? "remote_url";
			const values = {
				id,
				instanceId: input.instanceId,
				key: input.key,
				repoLocator,
				repoLocatorKind,
				baseBranch: input.baseBranch,
				workBranch: input.workBranch ?? null,
				externalId: input.externalId ?? null,
				externalUrl: input.externalUrl ?? null,
				metadata: input.metadata ? JSON.stringify(input.metadata) : null,
				pipelineStatus: input.pipelineStatus ?? null,
				createdAt: ts,
				updatedAt: ts,
			};
			db.insert(s.processProjects).values(values).run();
			return rowToProcessProject(values);
		},

		/** @internal */
		getById(id: string): ProcessProject | null {
			const row = db.select().from(s.processProjects).where(eq(s.processProjects.id, id)).get();
			return row ? rowToProcessProject(row) : null;
		},

		/** @public */
		listByInstance(instanceId: string): ProcessProject[] {
			return db
				.select()
				.from(s.processProjects)
				.where(eq(s.processProjects.instanceId, instanceId))
				.all()
				.map(rowToProcessProject);
		},

		/** @internal */
		listByInstances(instanceIds: readonly string[]): ProcessProject[] {
			if (instanceIds.length === 0) {
				return [];
			}
			return db
				.select()
				.from(s.processProjects)
				.where(inArray(s.processProjects.instanceId, [...instanceIds]))
				.all()
				.map(rowToProcessProject);
		},

		/** @internal */
		getByInstanceAndKey(instanceId: string, key: string): ProcessProject | null {
			const row = db
				.select()
				.from(s.processProjects)
				.where(and(eq(s.processProjects.instanceId, instanceId), eq(s.processProjects.key, key)))
				.get();
			return row ? rowToProcessProject(row) : null;
		},

		/** @public */
		update(id: string, input: UpdateProcessProjectInput): ProcessProject | null {
			const previous = this.getById(id);
			if (!previous) {
				return null;
			}

			const ts = now();
			const setValues: SQLiteUpdateSetSource<typeof s.processProjects> = {
				updatedAt: ts,
				workBranch: input.workBranch,
				externalId: input.externalId,
				externalUrl: input.externalUrl,
				pipelineStatus: input.pipelineStatus,
				baseBranch: input.baseBranch,
			};
			if (input.repoLocator !== undefined) {
				const repoLocator = assertRepoLocator(input.repoLocator);
				setValues.repoLocator = repoLocator;
				setValues.repoLocatorKind = detectRepoLocatorKind(repoLocator) ?? "remote_url";
			}
			if (input.metadata !== undefined)
				setValues.metadata = input.metadata ? JSON.stringify(input.metadata) : null;

			db.update(s.processProjects).set(setValues).where(eq(s.processProjects.id, id)).run();
			const row = db.select().from(s.processProjects).where(eq(s.processProjects.id, id)).get();
			return row ? rowToProcessProject(row) : null;
		},
	};
}
