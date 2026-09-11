import type {
	CompactTurnSummary,
	PrimaryPathUiSnapshot,
	TurnTracePreview,
} from "@leitwerk-dev/protocol";
import { eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { sessionSummaries, turnSummaries } from "./schema.js";

export interface SessionSummary {
	signature: string | null;
	leafId: string | null;
	primaryPath: Pick<
		PrimaryPathUiSnapshot,
		"currentLeaf" | "semanticEntryRefs" | "entryCount" | "turnAnnotations"
	>;
	prompt: { text: string | null; createdAt: string | null };
	tracePreviewsByTurnRecordId: Record<string, TurnTracePreview>;
	continuationByTurnRecordId: Record<string, { hasProgress: boolean; userPrompt: string | null }>;
}

export function createTurnSummaryRepo(db: LeitwerkDb) {
	return {
		get(turnRecordId: string): CompactTurnSummary | null {
			const row = db
				.select()
				.from(turnSummaries)
				.where(eq(turnSummaries.turnRecordId, turnRecordId))
				.get();
			return row ? (JSON.parse(row.summaryJson) as CompactTurnSummary) : null;
		},
		put(instanceId: string, turnRecordId: string, summary: CompactTurnSummary) {
			const summaryJson = JSON.stringify(summary);
			db.insert(turnSummaries)
				.values({ instanceId, turnRecordId, summaryJson })
				.onConflictDoUpdate({ target: turnSummaries.turnRecordId, set: { summaryJson } })
				.run();
		},
		listByInstance(instanceId: string): Record<string, CompactTurnSummary> {
			return Object.fromEntries(
				db
					.select()
					.from(turnSummaries)
					.where(eq(turnSummaries.instanceId, instanceId))
					.all()
					.map((row) => [row.turnRecordId, JSON.parse(row.summaryJson) as CompactTurnSummary]),
			);
		},
		getSession(instanceId: string): SessionSummary | null {
			const row = db
				.select()
				.from(sessionSummaries)
				.where(eq(sessionSummaries.instanceId, instanceId))
				.get();
			return row ? (JSON.parse(row.summaryJson) as SessionSummary) : null;
		},
		putSession(instanceId: string, summary: SessionSummary) {
			const summaryJson = JSON.stringify(summary);
			db.insert(sessionSummaries)
				.values({ instanceId, summaryJson })
				.onConflictDoUpdate({ target: sessionSummaries.instanceId, set: { summaryJson } })
				.run();
		},
		deleteSession(instanceId: string) {
			db.delete(sessionSummaries).where(eq(sessionSummaries.instanceId, instanceId)).run();
		},
	};
}
