import { describe, expect, it } from "vitest";
import { parseInstanceTree } from "./instance-tree.js";

function jsonl(...entries: readonly Record<string, unknown>[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("parseInstanceTree", () => {
	it("collects entries by id and skips the session header", () => {
		const content = jsonl(
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z" },
			{ type: "message", id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z" },
			{
				type: "message",
				id: "entry-2",
				parentId: "entry-1",
				timestamp: "2026-01-01T00:00:02.000Z",
			},
		);

		const tree = parseInstanceTree(content, { sourceLabel: "agt_1" });

		expect([...tree.entriesById.keys()]).toEqual(["entry-1", "entry-2"]);
		expect(tree.entriesById.get("entry-2")?.parentId).toBe("entry-1");
	});

	it("applies and clears labels by target id", () => {
		const content = jsonl(
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z" },
			{ type: "message", id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z" },
			{
				type: "label",
				id: "label-1",
				parentId: "entry-1",
				timestamp: "2026-01-01T00:00:02.000Z",
				targetId: "entry-1",
				label: "checkpoint",
			},
			{
				type: "label",
				id: "label-2",
				parentId: "entry-1",
				timestamp: "2026-01-01T00:00:03.000Z",
				targetId: "entry-2",
				label: "to-clear",
			},
			{
				type: "label",
				id: "label-3",
				parentId: "entry-1",
				timestamp: "2026-01-01T00:00:04.000Z",
				targetId: "entry-2",
				label: "",
			},
		);

		const tree = parseInstanceTree(content, { sourceLabel: "agt_1" });

		expect(tree.labelsByEntryId.get("entry-1")).toBe("checkpoint");
		expect(tree.labelsByEntryId.has("entry-2")).toBe(false);
	});

	it("skips malformed JSONL through canonical Pi session parsing", () => {
		const content = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "sess",
				timestamp: "2026-01-01T00:00:00.000Z",
			}),
			JSON.stringify({
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
			}),
			'{"type":"message","id":',
			JSON.stringify({
				type: "message",
				id: "entry-2",
				parentId: "entry-1",
				timestamp: "2026-01-01T00:00:02.000Z",
			}),
			"",
		].join("\n");
		const tree = parseInstanceTree(content, { sourceLabel: "agt_1" });

		expect([...tree.entriesById.keys()]).toEqual(["entry-1", "entry-2"]);
	});

	it("ignores entries without an id or type and non-object lines", () => {
		const content = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "sess",
				timestamp: "2026-01-01T00:00:00.000Z",
			}),
			JSON.stringify({ type: "message", parentId: null, timestamp: "2026-01-01T00:00:01.000Z" }),
			JSON.stringify({ id: "no-type", parentId: null, timestamp: "2026-01-01T00:00:02.000Z" }),
			JSON.stringify(["not", "an", "object"]),
			JSON.stringify(42),
			JSON.stringify({
				type: "message",
				id: "entry-ok",
				parentId: null,
				timestamp: "2026-01-01T00:00:03.000Z",
			}),
		].join("\n");

		const tree = parseInstanceTree(content, { sourceLabel: "agt_1" });

		expect([...tree.entriesById.keys()]).toEqual(["entry-ok"]);
	});

	it("uses canonical Pi entry validation", () => {
		const content = jsonl(
			{ type: "session", version: 3, id: "sess", timestamp: "2026-01-01T00:00:00.000Z" },
			{ type: "message", id: "missing-timestamp", parentId: null },
			{ type: "message", id: "entry-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z" },
		);

		const tree = parseInstanceTree(content, { sourceLabel: "agt_1" });

		expect([...tree.entriesById.keys()]).toEqual(["entry-1"]);
	});

	it("returns empty maps for blank content", () => {
		const tree = parseInstanceTree("\n  \n", { sourceLabel: "agt_1" });

		expect(tree.entriesById.size).toBe(0);
		expect(tree.labelsByEntryId.size).toBe(0);
	});
});
