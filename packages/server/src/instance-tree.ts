import type { PrimaryPathEntrySnapshot } from "@leitwerk-dev/protocol";
import { parsePiSessionTreeContent, type ReadonlyPiSessionTree } from "./pi-session-tree.js";

export interface ParsedInstanceTree {
	entriesById: Map<string, PrimaryPathEntrySnapshot>;
	labelsByEntryId: Map<string, string>;
}

export interface ParseInstanceTreeOptions {
	/** Identifier surfaced by the parsed tree. */
	sourceLabel: string;
}

export function createEmptyParsedInstanceTree(): ParsedInstanceTree {
	return {
		entriesById: new Map<string, PrimaryPathEntrySnapshot>(),
		labelsByEntryId: new Map<string, string>(),
	};
}

/**
 * Derives the lightweight entry/label maps used by primary-path snapshots and
 * leaf-outcome capture from the canonical Pi session tree representation.
 */
export function deriveParsedInstanceTree(tree: ReadonlyPiSessionTree): ParsedInstanceTree {
	const parsedTree = createEmptyParsedInstanceTree();
	const { entriesById, labelsByEntryId } = parsedTree;

	for (const entry of tree.entries) {
		if (entry.type === "label") {
			const targetId = typeof entry.targetId === "string" ? entry.targetId.trim() : "";
			if (!targetId) {
				continue;
			}
			const label = typeof entry.label === "string" ? entry.label.trim() : "";
			if (label) {
				labelsByEntryId.set(targetId, label);
			} else {
				labelsByEntryId.delete(targetId);
			}
			continue;
		}

		entriesById.set(entry.id, entry as PrimaryPathEntrySnapshot);
	}

	return parsedTree;
}

/**
 * Parses process session JSONL through the canonical Pi session parser, then
 * derives the lightweight projection used by legacy primary-path callers.
 */
export function parseInstanceTree(
	content: string,
	options: ParseInstanceTreeOptions,
): ParsedInstanceTree {
	return deriveParsedInstanceTree(parsePiSessionTreeContent(options.sourceLabel, content));
}
