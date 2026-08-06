import type {
	ProcessLeafOutcomeSnapshot,
	ProcessLeafOutcomeSnapshotStatus,
} from "@leitwerk-dev/domain";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface CreateProcessLeafOutcomeSnapshotInput {
	id?: string;
	instanceId: string;
	leafEntryId: string;
	turnRecordId?: string | null;
	rendererId?: string | null;
	schemaVersion?: number | null;
	props?: Record<string, unknown> | null;
	fallbackMarkdown?: string | null;
	status: ProcessLeafOutcomeSnapshotStatus;
	warningCode?: string | null;
	warningMessage?: string | null;
	anchoredAt: string;
	createdAt?: string;
}

function parseProps(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw) {
		return null;
	}
	try {
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function rowToProcessLeafOutcomeSnapshot(
	row: typeof s.processLeafOutcomeSnapshots.$inferSelect,
): ProcessLeafOutcomeSnapshot {
	return {
		id: row.id,
		instanceId: row.instanceId,
		leafEntryId: row.leafEntryId,
		turnRecordId: row.turnRecordId ?? null,
		rendererId: row.rendererId ?? null,
		schemaVersion: row.schemaVersion ?? null,
		props: parseProps(row.propsJson),
		fallbackMarkdown: row.fallbackMarkdown ?? null,
		status: row.status as ProcessLeafOutcomeSnapshotStatus,
		warningCode: row.warningCode ?? null,
		warningMessage: row.warningMessage ?? null,
		anchoredAt: row.anchoredAt,
		createdAt: row.createdAt,
	};
}

export function createProcessLeafOutcomeSnapshotRepo(db: LeitwerkDb) {
	return {
		create(input: CreateProcessLeafOutcomeSnapshotInput): ProcessLeafOutcomeSnapshot {
			const values = {
				id: input.id ?? generateId("los"),
				instanceId: input.instanceId,
				leafEntryId: input.leafEntryId,
				turnRecordId: input.turnRecordId ?? null,
				rendererId: input.rendererId ?? null,
				schemaVersion: input.schemaVersion ?? null,
				propsJson: input.props ? JSON.stringify(input.props) : null,
				fallbackMarkdown: input.fallbackMarkdown ?? null,
				status: input.status,
				warningCode: input.warningCode ?? null,
				warningMessage: input.warningMessage ?? null,
				anchoredAt: input.anchoredAt,
				createdAt: input.createdAt ?? now(),
			};
			db.insert(s.processLeafOutcomeSnapshots).values(values).run();
			return rowToProcessLeafOutcomeSnapshot(values);
		},

		listByInstance(instanceId: string): ProcessLeafOutcomeSnapshot[] {
			return db
				.select()
				.from(s.processLeafOutcomeSnapshots)
				.where(eq(s.processLeafOutcomeSnapshots.instanceId, instanceId))
				.orderBy(
					asc(s.processLeafOutcomeSnapshots.anchoredAt),
					asc(s.processLeafOutcomeSnapshots.createdAt),
				)
				.all()
				.map(rowToProcessLeafOutcomeSnapshot);
		},

		getByInstanceAndLeafEntryId(
			instanceId: string,
			leafEntryId: string,
		): ProcessLeafOutcomeSnapshot | null {
			const row = db
				.select()
				.from(s.processLeafOutcomeSnapshots)
				.where(
					and(
						eq(s.processLeafOutcomeSnapshots.instanceId, instanceId),
						eq(s.processLeafOutcomeSnapshots.leafEntryId, leafEntryId),
					),
				)
				.orderBy(desc(s.processLeafOutcomeSnapshots.createdAt), desc(sql`rowid`))
				.limit(1)
				.get();
			return row ? rowToProcessLeafOutcomeSnapshot(row) : null;
		},
	};
}
