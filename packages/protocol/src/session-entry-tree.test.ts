import { describe, expect, it } from "vitest";
import { createReadonlyEntryTree, type SessionTreeEntryLike } from "./session-entry-tree.js";

interface TestEntry extends SessionTreeEntryLike {
	payload: string;
}

function entry(
	id: string,
	parentId: string | null,
	payload = id,
	timestamp = `2026-04-26T00:00:0${id.length}.000Z`,
): TestEntry {
	return {
		id,
		parentId,
		timestamp,
		type: "message",
		payload,
	};
}

describe("createReadonlyEntryTree", () => {
	it("indexes entries, preserves sibling order, and returns a copied children list", () => {
		const entries = [
			entry("root", null),
			entry("child-a", "root"),
			entry("child-b", "root"),
			entry("grandchild", "child-b"),
		];

		const tree = createReadonlyEntryTree(entries);
		const children = tree.getChildren("root");
		children.pop();

		expect(tree.entries).toEqual(entries);
		expect(tree.entries).not.toBe(entries);
		expect(tree.leafId).toBe("grandchild");
		expect(tree.getEntry("child-a")?.payload).toBe("child-a");
		expect(tree.getChildren("root").map((candidate) => candidate.id)).toEqual([
			"child-a",
			"child-b",
		]);
	});

	it("walks the parent chain from an explicit entry id or the current leaf", () => {
		const entries = [
			entry("root", null),
			entry("child-a", "root"),
			entry("child-b", "root"),
			entry("grandchild", "child-b"),
		];

		const tree = createReadonlyEntryTree(entries);

		expect(tree.getBranch("grandchild").map((candidate) => candidate.id)).toEqual([
			"root",
			"child-b",
			"grandchild",
		]);
		expect(tree.getBranch().map((candidate) => candidate.id)).toEqual([
			"root",
			"child-b",
			"grandchild",
		]);
	});

	it("stops branch traversal when it encounters a cycle", () => {
		const entries = [entry("a", "b"), entry("b", "a")];

		const tree = createReadonlyEntryTree(entries);

		expect(tree.getBranch("b").map((candidate) => candidate.id)).toEqual(["a", "b"]);
	});

	it("treats blank parent ids as unattached roots for child indexing", () => {
		const entries = [entry("blank-parent", "   "), entry("leaf", "blank-parent")];

		const tree = createReadonlyEntryTree(entries);

		expect(tree.getChildren("   ")).toEqual([]);
		expect(tree.getBranch("blank-parent").map((candidate) => candidate.id)).toEqual([
			"blank-parent",
		]);
		expect(tree.getBranch("leaf").map((candidate) => candidate.id)).toEqual([
			"blank-parent",
			"leaf",
		]);
	});
});
