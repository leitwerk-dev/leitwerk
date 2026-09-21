import { describe, expect, it } from "vitest";
import type { ApiNode, Snapshot } from "../src/model";
import {
	clearNotes,
	makeNote,
	markdownExport,
	mergeNotes,
	parseBackup,
	storageKey,
	undoNoteClear,
} from "../src/notes";

const node: ApiNode = {
	id: "api|fixture|.|Widget",
	label: "Widget",
	qualifiedName: "Widget",
	kind: "class",
	package: "fixture",
	entry: ".",
	source: {
		path: "packages/fixture/index.ts",
		line: 12,
		column: 1,
		snippet: "export class Widget {}",
	},
};
const snapshot = {
	repository: { id: "repo-a", name: "Fixture", revision: "abc" },
	generatedAt: "2026-09-19T00:00:00Z",
	nodes: [node],
} as Snapshot;
describe("portable notes", () => {
	it("round trips exact Markdown and exports hidden and absent node context", () => {
		const text =
			'# Unicode ✓\n\n```ts\nconst s = "<script>";\n```\n\n[link](https://example.com)\n';
		const note = makeNote(node, text, "2026-09-19T00:00:00Z");
		const backup = { version: 1, repositoryId: "repo-a", notes: { [node.id]: note } };
		expect(parseBackup(JSON.stringify(backup), "repo-a")).toEqual(backup);
		const md = markdownExport(backup.notes, { ...snapshot, nodes: [] });
		expect(md).toContain(text);
		expect(md).toContain("packages/fixture/index.ts:12");
		expect(md).toContain("Absent from the current snapshot.");
		expect(storageKey("repo-a")).not.toBe(storageKey("repo-b"));
	});
	it("merges by instant, keeps local on ties, and keeps deletion tombstones", () => {
		const local = makeNote(node, "local", "2026-09-19T00:00:00Z");
		const same = makeNote(node, "incoming", "2026-09-19T02:00:00+02:00");
		expect(mergeNotes({ [node.id]: local }, { [node.id]: same })[node.id].text).toBe("local");
		const deletion = makeNote(node, "", "2026-09-20T00:00:00Z");
		expect(mergeNotes({ [node.id]: deletion }, { [node.id]: local })[node.id].text).toBe("");
		expect(markdownExport({ [node.id]: deletion }, snapshot)).not.toContain("### Widget");
		expect(mergeNotes({ [node.id]: local }, { [node.id]: deletion })[node.id].text).toBe("");
	});
	it("rejects wrong repositories, malformed notes, and future versions", () => {
		expect(() =>
			parseBackup('{"version":2,"repositoryId":"repo-a","notes":{}}', "repo-a"),
		).toThrow();
		expect(() =>
			parseBackup('{"version":1,"repositoryId":"repo-b","notes":{}}', "repo-a"),
		).toThrow();
		expect(() =>
			parseBackup('{"version":1,"repositoryId":"repo-a","notes":{"x":{"text":42}}}', "repo-a"),
		).toThrow();
	});
	it("clears individual or all notes, including absent nodes, without resurrecting older backups", () => {
		const original = {
			[node.id]: makeNote(node, "Keep **Markdown**", "2026-10-01T00:00:00Z"),
			absent: makeNote({ ...node, id: "absent" }, "Absent note", "2026-09-19T00:00:00Z"),
		};
		const single = clearNotes(original, [node.id], "2026-09-20T00:00:00Z");
		expect(single.notes[node.id].text).toBe("");
		expect(single.notes.absent).toEqual(original.absent);
		expect(mergeNotes(single.notes, original)[node.id].text).toBe("");
		const all = clearNotes(original, undefined, "2026-09-20T00:00:00Z");
		expect(Object.values(all.notes).every((note) => !note.text)).toBe(true);
		expect(all.notes.absent.context).toEqual(original.absent.context);
		expect(markdownExport(all.notes, snapshot)).not.toContain("###");
		expect(original[node.id].text).toBe("Keep **Markdown**");
	});
	it("undoes a clear while preserving edits made afterwards", () => {
		const original = {
			[node.id]: makeNote(node, "Original", "2026-09-19T00:00:00Z"),
			absent: makeNote({ ...node, id: "absent" }, "Absent note", "2026-09-19T00:00:00Z"),
		};
		const cleared = clearNotes(original, undefined, "2026-09-20T00:00:00Z");
		const edited = {
			...cleared.notes,
			[node.id]: makeNote(node, "New edit", "2026-09-21T00:00:00Z"),
		};
		const restored = undoNoteClear(edited, cleared.undo, "2026-09-22T00:00:00Z");
		expect(restored[node.id].text).toBe("New edit");
		expect(restored.absent.text).toBe("Absent note");
		expect(mergeNotes(restored, cleared.notes).absent.text).toBe("Absent note");
	});
});
