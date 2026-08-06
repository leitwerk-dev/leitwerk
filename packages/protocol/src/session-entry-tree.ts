export interface SessionTreeEntryLike {
	id: string;
	parentId: string | null;
	timestamp: string;
	type: string;
}

export interface ReadonlyEntryTree<TEntry extends SessionTreeEntryLike> {
	entries: TEntry[];
	leafId: string | null;
	getEntry(id: string): TEntry | undefined;
	getChildren(parentId: string): TEntry[];
	getBranch(fromId?: string | null): TEntry[];
}

export function createReadonlyEntryTree<TEntry extends SessionTreeEntryLike>(
	entries: readonly TEntry[],
): ReadonlyEntryTree<TEntry> {
	const orderedEntries = [...entries];
	const entriesById = new Map(orderedEntries.map((entry) => [entry.id, entry]));
	const childrenByParentId = new Map<string, TEntry[]>();

	for (const entry of orderedEntries) {
		if (typeof entry.parentId !== "string" || entry.parentId.trim() === "") {
			continue;
		}
		const siblings = childrenByParentId.get(entry.parentId) ?? [];
		siblings.push(entry);
		childrenByParentId.set(entry.parentId, siblings);
	}

	const leafId = orderedEntries.at(-1)?.id ?? null;

	const getEntry = (id: string): TEntry | undefined => entriesById.get(id);
	const getChildren = (parentId: string): TEntry[] =>
		(childrenByParentId.get(parentId) ?? []).slice();
	const getBranch = (fromId?: string | null): TEntry[] => {
		const resolvedFromId = fromId ?? leafId ?? undefined;
		if (!resolvedFromId) {
			return [];
		}
		const branch: TEntry[] = [];
		const visited = new Set<string>();
		let currentEntry = entriesById.get(resolvedFromId);
		while (currentEntry) {
			if (visited.has(currentEntry.id)) {
				break;
			}
			visited.add(currentEntry.id);
			branch.unshift(currentEntry);
			currentEntry = currentEntry.parentId ? entriesById.get(currentEntry.parentId) : undefined;
		}
		return branch;
	};

	return {
		entries: orderedEntries,
		leafId,
		getEntry,
		getChildren,
		getBranch,
	};
}
