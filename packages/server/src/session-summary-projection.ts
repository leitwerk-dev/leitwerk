import {
	applyEventToCompactTurnSummary,
	emptyCompactTurnSummary,
	extractFirstUserPromptOnBranch,
	hasTurnContinuationProgress,
	type PiSessionEntry,
	type ReadonlyEntryTree,
	resolveTurnContinuationUserPrompt,
} from "@leitwerk-dev/protocol";
import type { RepositoryBundle } from "./db/repositories.js";
import { buildPrimaryPathSnapshotFromTree } from "./primary-path-snapshot.js";
import { ProcessSessionReader, type ProcessSessionSnapshotStore } from "./process-session-store.js";
import { buildTurnTracePreviewsFromSession } from "./process-turn-trace.js";

/** Project on snapshot acceptance, never on a page read. The SQLite projection survives cold starts. */
export function createProjectedSessionSnapshotStore(
	source: ProcessSessionSnapshotStore,
	repos: RepositoryBundle,
) {
	const reader = new ProcessSessionReader(source);
	const pending = new Map<string, Promise<unknown>>();
	async function project(instanceId: string) {
		const session = await reader.readSessionTree(instanceId);
		const process = repos.processes.getById(instanceId);
		if (!process) return;
		const turnRecords = repos.turnRecords.listByInstance(instanceId);
		const primaryPath = buildPrimaryPathSnapshotFromTree({
			process,
			turnRecords,
			turnAnnotations: repos.turnAnnotations.listByInstance(instanceId),
			workerLease: null,
			events: [],
			tree: session.parsedTree,
		});
		const entries = session.piTree.entries as unknown as PiSessionEntry[];
		repos.turnSummaries.putSession(instanceId, {
			signature: session.signature,
			leafId: session.piTree.leafId,
			primaryPath: {
				currentLeaf: primaryPath.currentLeaf,
				semanticEntryRefs: primaryPath.semanticEntryRefs,
				entryCount: primaryPath.primaryPathEntries.length,
				turnAnnotations: primaryPath.turnAnnotations,
			},
			prompt: extractFirstUserPromptOnBranch(
				session.piTree as unknown as ReadonlyEntryTree<PiSessionEntry>,
				primaryPath.currentLeaf?.entryId ?? null,
			),
			tracePreviewsByTurnRecordId: buildTurnTracePreviewsFromSession({
				tree: session.piTree,
				turnRecords,
			}),
			continuationByTurnRecordId: Object.fromEntries(
				turnRecords
					.filter((turn) => turn.turnType === "llm")
					.map((turn) => [
						turn.id,
						{
							hasProgress: hasTurnContinuationProgress(entries, turn, { endedAt: turn.endedAt }),
							userPrompt: resolveTurnContinuationUserPrompt(entries, turn, {
								endedAt: turn.endedAt,
							}),
						},
					]),
			),
		});
	}
	function serial<T>(instanceId: string, operation: () => Promise<T>): Promise<T> {
		const next = (pending.get(instanceId) ?? Promise.resolve()).catch(() => {}).then(operation);
		pending.set(instanceId, next);
		void next
			.finally(() => {
				if (pending.get(instanceId) === next) pending.delete(instanceId);
			})
			.catch(() => {});
		return next;
	}
	return {
		...source,
		writeSnapshot(instanceId, content) {
			return serial(instanceId, async () => {
				const result = await source.writeSnapshot(instanceId, content);
				await project(instanceId);
				return result;
			});
		},
		writeSnapshotFile(instanceId, contentPath) {
			return serial(instanceId, async () => {
				const result = await source.writeSnapshotFile(instanceId, contentPath);
				await project(instanceId);
				return result;
			});
		},
		deleteSnapshot(instanceId) {
			return serial(instanceId, async () => {
				await source.deleteSnapshot(instanceId);
				repos.turnSummaries.deleteSession(instanceId);
			});
		},
		backfill(instanceId: string) {
			return serial(instanceId, async () => {
				for (const turn of repos.turnRecords.listByInstance(instanceId)) {
					if (repos.turnSummaries.get(turn.id)) continue;
					let summary = emptyCompactTurnSummary();
					for (const event of repos.events.listByTurnRecord(instanceId, turn.id)) {
						summary = applyEventToCompactTurnSummary(summary, {
							...event,
							eventSequence: event.eventSequence ?? 0,
						});
					}
					repos.turnSummaries.put(instanceId, turn.id, summary);
				}
				const handle = await source.readSnapshotHandle(instanceId);
				if (repos.turnSummaries.getSession(instanceId)?.signature !== (handle?.signature ?? null))
					await project(instanceId);
			});
		},
	} satisfies ProcessSessionSnapshotStore & { backfill(instanceId: string): Promise<void> };
}
