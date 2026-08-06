import {
	assertRepoLocator,
	detectRepoLocatorKind,
	type ProcessProject,
} from "@leitwerk-dev/domain";
import { and, eq, inArray } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface CreateProcessProjectInput {
	instanceId: string;
	key: string;
	repoLocator: string;
	baseBranch: string;
	workBranch?: string | null;
	externalId?: string | null;
	externalUrl?: string | null;
	metadata?: Record<string, unknown> | null;
	pipelineStatus?: string | null;
}

export interface UpdateProcessProjectInput {
	repoLocator?: string;
	workBranch?: string | null;
	externalId?: string | null;
	externalUrl?: string | null;
	metadata?: Record<string, unknown> | null;
	pipelineStatus?: string | null;
	baseBranch?: string;
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
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

export function createProcessProjectRepo(db: LeitwerkDb) {
	return {
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

		getById(id: string): ProcessProject | null {
			const row = db.select().from(s.processProjects).where(eq(s.processProjects.id, id)).get();
			return row ? rowToProcessProject(row) : null;
		},

		listByInstance(instanceId: string): ProcessProject[] {
			return db
				.select()
				.from(s.processProjects)
				.where(eq(s.processProjects.instanceId, instanceId))
				.all()
				.map(rowToProcessProject);
		},

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

		getByInstanceAndKey(instanceId: string, key: string): ProcessProject | null {
			const row = db
				.select()
				.from(s.processProjects)
				.where(and(eq(s.processProjects.instanceId, instanceId), eq(s.processProjects.key, key)))
				.get();
			return row ? rowToProcessProject(row) : null;
		},

		update(id: string, input: UpdateProcessProjectInput): ProcessProject | null {
			const previous = this.getById(id);
			if (!previous) {
				return null;
			}

			const ts = now();
			const setValues: Record<string, unknown> = { updatedAt: ts };
			if (input.repoLocator !== undefined) {
				const repoLocator = assertRepoLocator(input.repoLocator);
				setValues.repoLocator = repoLocator;
				setValues.repoLocatorKind = detectRepoLocatorKind(repoLocator) ?? "remote_url";
			}
			if (input.workBranch !== undefined) setValues.workBranch = input.workBranch;
			if (input.externalId !== undefined) setValues.externalId = input.externalId;
			if (input.externalUrl !== undefined) setValues.externalUrl = input.externalUrl;
			if (input.metadata !== undefined)
				setValues.metadata = input.metadata ? JSON.stringify(input.metadata) : null;
			if (input.pipelineStatus !== undefined) setValues.pipelineStatus = input.pipelineStatus;
			if (input.baseBranch !== undefined) setValues.baseBranch = input.baseBranch;

			db.update(s.processProjects).set(setValues).where(eq(s.processProjects.id, id)).run();
			const row = db.select().from(s.processProjects).where(eq(s.processProjects.id, id)).get();
			const project = row ? rowToProcessProject(row) : null;
			if (!project) {
				return null;
			}

			return project;
		},

		deleteByInstance(instanceId: string): number {
			const result = db
				.delete(s.processProjects)
				.where(eq(s.processProjects.instanceId, instanceId))
				.run();
			return result.changes;
		},
	};
}
