import { describe, expect, it } from "vitest";
import { parsePiSessionTreeContent } from "./pi-session-tree.js";

function usage() {
	return {
		input: 12,
		output: 4,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 16,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function jsonl(...entries: readonly Record<string, unknown>[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

describe("parsePiSessionTreeContent", () => {
	it("parses JSONL entries, migrates legacy trees, and exposes read-only tree semantics", () => {
		const content = jsonl(
			{
				type: "session",
				id: "sess_1",
				timestamp: "2026-04-22T10:00:00.000Z",
				cwd: "/tmp/project",
			},
			{
				type: "message",
				timestamp: "2026-04-22T10:00:01.000Z",
				message: {
					role: "user",
					content: "Plan this change",
					timestamp: 1,
				},
			},
			{
				type: "message",
				timestamp: "2026-04-22T10:00:02.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "## Plan\n\n- Inspect the repo" }],
					api: "openai-responses",
					provider: "openai",
					model: "gpt-5",
					usage: usage(),
					stopReason: "stop",
					timestamp: 2,
				},
			},
		);

		const tree = parsePiSessionTreeContent("agt_1", content);

		expect(tree.treeFile).toBe("agt_1");
		expect(tree.header).toMatchObject({ id: "sess_1", cwd: "/tmp/project", version: 3 });
		expect(tree.entries).toHaveLength(2);
		expect(tree.leafId).toBe(tree.entries[1]?.id ?? null);
		expect(tree.entries[0]?.id).toEqual(expect.any(String));
		expect(tree.entries[0]?.id.length).toBeGreaterThan(0);
		expect(tree.entries[0]?.parentId).toBeNull();
		expect(tree.entries[1]?.parentId).toBe(tree.entries[0]?.id ?? null);
		expect(tree.getEntry(tree.entries[0]?.id ?? "missing")).toEqual(tree.entries[0]);
		expect(tree.getChildren(tree.entries[0]?.id ?? "missing")).toEqual([tree.entries[1]]);
		expect(tree.getBranch(tree.entries[1]?.id ?? "missing")).toEqual(tree.entries);
		expect(tree.getTree()).toEqual([
			expect.objectContaining({
				entry: tree.entries[0],
				children: [expect.objectContaining({ entry: tree.entries[1], children: [] })],
			}),
		]);
	});

	it("returns an empty tree for blank content", () => {
		const tree = parsePiSessionTreeContent("agt_1", "\n  \n");

		expect(tree.treeFile).toBe("agt_1");
		expect(tree.header).toBeNull();
		expect(tree.entries).toEqual([]);
		expect(tree.leafId).toBeNull();
		expect(tree.getTree()).toEqual([]);
	});
});
