import { trimToNull } from "@leitwerk-dev/domain";
import {
	extractPiSessionMessageText,
	isPiSessionMessageEntryType,
	isPiSessionMessageEntryWithRecord,
} from "./pi-session-message.js";
import { createReadonlyEntryTree, type ReadonlyEntryTree } from "./session-entry-tree.js";
import { compareTimestampStrings, happenedOnOrAfterStart } from "./timestamp-ordering.js";

export interface ContinuationTreeEntry {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

export interface ContinuationTurnRecordLike {
	forkPiEntryId?: string | null;
	resultPiEntryId?: string | null;
	startedAt?: string | null;
	status?: string | null;
}

export interface ContinuationSliceBounds {
	endedAt?: string | null;
}

export interface TurnContinuationIndex<TEntry extends ContinuationTreeEntry> {
	resolveLeafEntryId(
		turnRecord: ContinuationTurnRecordLike,
		bounds?: ContinuationSliceBounds,
	): string | null;
	buildSlice(turnRecord: ContinuationTurnRecordLike, bounds?: ContinuationSliceBounds): TEntry[];
}

function createEntriesById(
	entries: readonly ContinuationTreeEntry[],
): Map<string, ContinuationTreeEntry> {
	return new Map(entries.map((entry) => [entry.id, entry]));
}

function branchContainsAncestor(
	entriesById: ReadonlyMap<string, ContinuationTreeEntry>,
	entryId: string,
	ancestorId: string,
): boolean {
	const visited = new Set<string>();
	let current = entriesById.get(entryId);
	while (current) {
		if (visited.has(current.id)) {
			return false;
		}
		visited.add(current.id);
		if (current.id === ancestorId) {
			return true;
		}
		current = current.parentId ? entriesById.get(current.parentId) : undefined;
	}
	return false;
}

function happenedOnOrBeforeEnd(entryTimestamp: string, endedAt: string | null): boolean {
	if (!endedAt) {
		return true;
	}
	return compareTimestampStrings(entryTimestamp, endedAt) <= 0;
}

function isContinuableEntryType(
	entry: ContinuationTreeEntry | undefined,
): entry is ContinuationTreeEntry {
	return isPiSessionMessageEntryType(entry) || entry?.type === "compaction";
}

function isExplicitLeafUsable(
	entriesById: ReadonlyMap<string, ContinuationTreeEntry>,
	leafId: string,
	forkPiEntryId: string | null,
	startedAt: string | null,
	endedAt: string | null,
): boolean {
	const leafEntry = entriesById.get(leafId);
	if (!isContinuableEntryType(leafEntry)) {
		return false;
	}
	if (!happenedOnOrAfterStart(leafEntry.timestamp, startedAt)) {
		return false;
	}
	if (!happenedOnOrBeforeEnd(leafEntry.timestamp, endedAt)) {
		return false;
	}
	if (!forkPiEntryId) {
		return true;
	}
	return branchContainsAncestor(entriesById, leafId, forkPiEntryId);
}

function findLatestContinuableEntryIdOnBranch(
	entries: readonly ContinuationTreeEntry[],
	entriesById: ReadonlyMap<string, ContinuationTreeEntry>,
	options: { startedAt: string | null; endedAt: string | null; ancestorId: string | null },
): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry) {
			continue;
		}
		if (!isContinuableEntryType(entry)) {
			continue;
		}
		if (!happenedOnOrAfterStart(entry.timestamp, options.startedAt)) {
			continue;
		}
		if (!happenedOnOrBeforeEnd(entry.timestamp, options.endedAt)) {
			continue;
		}
		if (options.ancestorId && !branchContainsAncestor(entriesById, entry.id, options.ancestorId)) {
			continue;
		}
		return entry.id;
	}
	return null;
}

function readMessageRole(entry: ContinuationTreeEntry | undefined): string | null {
	const role = entry?.message?.role;
	return typeof role === "string" && role.trim() !== "" ? role : null;
}

function resolveTurnContinuationLeafEntryIdFromIndex(
	entries: readonly ContinuationTreeEntry[],
	entriesById: ReadonlyMap<string, ContinuationTreeEntry>,
	turnRecord: ContinuationTurnRecordLike,
	bounds: ContinuationSliceBounds = {},
): string | null {
	const startedAt = trimToNull(turnRecord.startedAt);
	const endedAt = trimToNull(bounds.endedAt);
	const forkPiEntryId = trimToNull(turnRecord.forkPiEntryId);
	const explicitLeafId = trimToNull(turnRecord.resultPiEntryId);
	if (
		explicitLeafId &&
		isExplicitLeafUsable(entriesById, explicitLeafId, forkPiEntryId, startedAt, endedAt)
	) {
		if (turnRecord.status !== "failed") {
			return explicitLeafId;
		}
		return findLatestContinuableEntryIdOnBranch(entries, entriesById, {
			startedAt,
			endedAt,
			ancestorId: explicitLeafId,
		});
	}

	return findLatestContinuableEntryIdOnBranch(entries, entriesById, {
		startedAt,
		endedAt,
		ancestorId: forkPiEntryId,
	});
}

export function createTurnContinuationIndex<TEntry extends ContinuationTreeEntry>(
	entries: readonly TEntry[],
): TurnContinuationIndex<TEntry> {
	const orderedEntries = entries;
	const entriesById = createEntriesById(orderedEntries);

	const resolveLeafEntryId = (
		turnRecord: ContinuationTurnRecordLike,
		bounds: ContinuationSliceBounds = {},
	): string | null =>
		resolveTurnContinuationLeafEntryIdFromIndex(orderedEntries, entriesById, turnRecord, bounds);

	const buildSlice = (
		turnRecord: ContinuationTurnRecordLike,
		bounds: ContinuationSliceBounds = {},
	): TEntry[] => {
		const continuationLeafId = resolveLeafEntryId(turnRecord, bounds);
		if (!continuationLeafId) {
			return [];
		}
		const forkPiEntryId = trimToNull(turnRecord.forkPiEntryId);
		const reversedSlice: TEntry[] = [];
		const visited = new Set<string>();
		let current = entriesById.get(continuationLeafId) as TEntry | undefined;
		let foundFork = forkPiEntryId === null;
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			if (current.id === forkPiEntryId) {
				foundFork = true;
				break;
			}
			reversedSlice.push(current);
			current = current.parentId
				? (entriesById.get(current.parentId) as TEntry | undefined)
				: undefined;
		}
		if (!foundFork) {
			return [];
		}
		const startedAt = trimToNull(turnRecord.startedAt);
		const endedAt = trimToNull(bounds.endedAt);
		return reversedSlice
			.reverse()
			.filter(
				(entry) =>
					happenedOnOrAfterStart(entry.timestamp, startedAt) &&
					happenedOnOrBeforeEnd(entry.timestamp, endedAt),
			);
	};

	return { resolveLeafEntryId, buildSlice };
}

export function resolveTurnContinuationLeafEntryId(
	entries: readonly ContinuationTreeEntry[],
	turnRecord: ContinuationTurnRecordLike,
	bounds: ContinuationSliceBounds = {},
): string | null {
	return createTurnContinuationIndex(entries).resolveLeafEntryId(turnRecord, bounds);
}

export function buildTurnContinuationSliceFromTree<TEntry extends ContinuationTreeEntry>(
	tree: ReadonlyEntryTree<TEntry>,
	turnRecord: ContinuationTurnRecordLike,
	bounds: ContinuationSliceBounds = {},
): TEntry[] {
	return createTurnContinuationIndex(tree.entries).buildSlice(turnRecord, bounds);
}

export function buildTurnContinuationSlice<TEntry extends ContinuationTreeEntry>(
	entries: readonly TEntry[],
	turnRecord: ContinuationTurnRecordLike,
	bounds: ContinuationSliceBounds = {},
): TEntry[] {
	return buildTurnContinuationSliceFromTree(createReadonlyEntryTree(entries), turnRecord, bounds);
}

export interface BranchUserPromptSnapshot {
	text: string | null;
	createdAt: string | null;
}

export function extractFirstUserPromptOnBranch<TEntry extends ContinuationTreeEntry>(
	tree: ReadonlyEntryTree<TEntry>,
	leafId: string | null | undefined,
): BranchUserPromptSnapshot {
	const resolvedLeafId = trimToNull(leafId);
	if (!resolvedLeafId) {
		return { text: null, createdAt: null };
	}
	const branch = tree.getBranch(resolvedLeafId);
	for (const entry of branch) {
		if (!isPiSessionMessageEntryWithRecord(entry) || readMessageRole(entry) !== "user") {
			continue;
		}
		const text = extractPiSessionMessageText(entry.message.content).trim();
		if (text === "") {
			continue;
		}
		return {
			text,
			createdAt: entry.timestamp,
		};
	}
	return { text: null, createdAt: null };
}

export function resolveTurnContinuationUserPrompt(
	entries: readonly ContinuationTreeEntry[],
	turnRecord: ContinuationTurnRecordLike,
	bounds: ContinuationSliceBounds = {},
): string | null {
	const continuationLeafId = resolveTurnContinuationLeafEntryId(entries, turnRecord, bounds);
	if (!continuationLeafId) {
		return null;
	}
	const continuationLeaf = createEntriesById(entries).get(continuationLeafId);
	if (
		!isPiSessionMessageEntryWithRecord(continuationLeaf) ||
		readMessageRole(continuationLeaf) !== "user"
	) {
		return null;
	}
	const promptText = extractPiSessionMessageText(continuationLeaf.message.content).trim();
	return promptText !== "" ? promptText : null;
}

export function hasTurnContinuationProgress(
	entries: readonly ContinuationTreeEntry[],
	turnRecord: ContinuationTurnRecordLike,
	bounds: ContinuationSliceBounds = {},
): boolean {
	return resolveTurnContinuationLeafEntryId(entries, turnRecord, bounds) !== null;
}
