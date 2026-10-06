import { describe, expect, it } from "vitest";
import { formatBranchText, StubPiTreeHandle } from "./stub-pi-tree-handle.js";

it("preserves each caller's missing-message formatting", () => {
	const entry = { id: "1", parentId: null, timestamp: "", type: "message" };
	const entries = [entry, { ...entry, type: "custom_message", content: "text" }];
	expect(formatBranchText(entries)).toBe("text");
	expect(formatBranchText(entries, "")).toBe("\n\ntext");
});

describe("StubPiTreeHandle compaction", () => {
	it("persists non-context compaction details", async () => {
		const handle = new StubPiTreeHandle({
			sessionId: "stub-session",
			treeFile: "/tmp/stub-tree.jsonl",
			isResumed: false,
		});
		const details = { kind: "leitwerk_turn_compaction", turnRecordId: "turn-record-1" };

		await handle.compact("compress the turn", details);

		const entryId = handle.getLeafId();
		expect(entryId).not.toBeNull();
		if (entryId === null) {
			throw new Error("Compaction did not create a tree entry");
		}
		expect(handle.getEntry(entryId)).toMatchObject({
			type: "compaction",
			details,
		});
	});
});
