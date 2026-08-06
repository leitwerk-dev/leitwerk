import {
	type FileEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { createReadonlyEntryTree } from "@leitwerk-dev/protocol";

export interface PiSessionTreeNode {
	entry: SessionEntry;
	children: PiSessionTreeNode[];
	label?: string;
}

export interface ReadonlyPiSessionTree {
	/** Identifier of the parsed source (instance id or file path). */
	treeFile: string;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	getEntry(id: string): SessionEntry | undefined;
	getChildren(parentId: string): SessionEntry[];
	getBranch(fromId?: string): SessionEntry[];
	getTree(): PiSessionTreeNode[];
}

function isFileRecord(entry: unknown): entry is FileEntry {
	return typeof entry === "object" && entry !== null && !Array.isArray(entry);
}

function isSessionHeader(entry: FileEntry): entry is SessionHeader {
	return entry.type === "session";
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
	return (
		typeof entry.type === "string" &&
		entry.type.trim() !== "" &&
		entry.type !== "session" &&
		typeof entry.id === "string" &&
		entry.id.trim() !== "" &&
		(entry.parentId === null || typeof entry.parentId === "string") &&
		typeof entry.timestamp === "string"
	);
}

export function createEmptyReadonlyPiSessionTree(treeFile: string): ReadonlyPiSessionTree {
	return {
		treeFile,
		header: null,
		entries: [],
		leafId: null,
		getEntry() {
			return undefined;
		},
		getChildren() {
			return [];
		},
		getBranch() {
			return [];
		},
		getTree() {
			return [];
		},
	};
}

function createReadonlyPiSessionTree(
	treeFile: string,
	fileEntries: FileEntry[],
): ReadonlyPiSessionTree {
	fileEntries = fileEntries.filter(isFileRecord);
	migrateSessionEntries(fileEntries);

	const header = fileEntries.find(isSessionHeader) ?? null;
	const entryTree = createReadonlyEntryTree(fileEntries.filter(isSessionEntry));
	const { entries, leafId, getEntry, getChildren, getBranch } = entryTree;
	const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
	const labelsByTargetId = new Map<string, string>();

	for (const entry of entries) {
		if (entry.type !== "label") {
			continue;
		}
		const targetId = typeof entry.targetId === "string" ? entry.targetId.trim() : "";
		if (!targetId) {
			continue;
		}
		if (typeof entry.label === "string" && entry.label.trim() !== "") {
			labelsByTargetId.set(targetId, entry.label);
		} else {
			labelsByTargetId.delete(targetId);
		}
	}

	const buildTreeNode = (entry: SessionEntry, visited: Set<string>): PiSessionTreeNode => {
		visited.add(entry.id);
		return {
			entry,
			children: getChildren(entry.id)
				.filter((child) => !visited.has(child.id))
				.map((child) => buildTreeNode(child, visited)),
			...(labelsByTargetId.has(entry.id) ? { label: labelsByTargetId.get(entry.id) } : {}),
		};
	};

	const getTree = (): PiSessionTreeNode[] => {
		const visited = new Set<string>();
		const rootEntries = entries.filter(
			(entry) => entry.parentId === null || !entriesById.has(entry.parentId),
		);
		const roots = rootEntries.map((entry) => buildTreeNode(entry, visited));
		for (const entry of entries) {
			if (visited.has(entry.id)) {
				continue;
			}
			roots.push(buildTreeNode(entry, visited));
		}
		return roots;
	};

	return {
		treeFile,
		header,
		entries,
		leafId,
		getEntry,
		getChildren,
		getBranch,
		getTree,
	};
}

/**
 * Parses process session JSONL into a read-only Pi session tree.
 *
 * Pure: the caller owns reading the content. `sourceLabel` is surfaced as
 * `treeFile` for diagnostics.
 */
export function parsePiSessionTreeContent(
	sourceLabel: string,
	content: string,
): ReadonlyPiSessionTree {
	if (content.trim() === "") {
		return createEmptyReadonlyPiSessionTree(sourceLabel);
	}
	return createReadonlyPiSessionTree(sourceLabel, parseSessionEntries(content));
}
