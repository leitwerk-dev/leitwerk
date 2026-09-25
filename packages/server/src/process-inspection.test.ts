import type {
	InspectionContextObservation,
	PreparedTurnStart,
	ProcessTurnRecord,
} from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { parsePiSessionTreeContent } from "./pi-session-tree.js";
import { createInspectionLineage } from "./process-inspection.js";
import { buildInspectionTraceMessages } from "./process-inspection-trace.js";
import { createTestTurnRecord } from "./test-helpers/process-model-fixtures.js";

const record = (id: string, props: Partial<ProcessTurnRecord> = {}) =>
	createTestTurnRecord({
		id,
		turnId: id,
		turnStartRecordId: `start-${id}`,
		resultPiEntryId: `${id}-result`,
		...props,
	});
const supplied = (id: string, origin: PreparedTurnStart): InspectionContextObservation => ({
	id: `supply-${id}`,
	turnRecordId: id,
	fact: { kind: "supplied_context", products: [], origin },
});
const linked = (turnRecordId: string, entryId: string): InspectionContextObservation => ({
	id: entryId,
	turnRecordId,
	fact: { kind: "entry_link", entryId, piTurnId: "pi", role: "assistant" },
});
const tree = (entries: unknown[]) =>
	parsePiSessionTreeContent(
		"synthetic",
		[{ type: "session", version: 3, id: "session", timestamp: "0", cwd: "/tmp" }, ...entries]
			.map((e) => JSON.stringify(e))
			.join("\n"),
	);

describe("inspection lineage", () => {
	it.each([
		"fresh",
		"fresh_seeded",
	] as const)("separates %s origin from supplied information and structure", (contextMode) => {
		const execution = record("a", { pathType: "primary", forkPiEntryId: null });
		const lineage = createInspectionLineage({
			records: [execution],
			leases: [],
			observations: [
				supplied("a", {
					pathType: "primary",
					contextMode,
					startTarget: { kind: "root" },
					forkPiEntryId: null,
				}),
			],
		});
		expect(lineage.origin(execution)).toMatchObject({
			authoredMode: { value: contextMode },
			conversation: { state: "recorded", value: null },
			structuralPath: "primary",
		});
	});
	it("resolves intermediate boundaries and ancestry while retaining compaction as a separate mode", () => {
		const records = [
			record("a"),
			record("b", { forkPiEntryId: "middle-a" }),
			record("c", { forkPiEntryId: "middle-b" }),
		];
		const lineage = createInspectionLineage({
			records,
			leases: [],
			observations: [
				linked("a", "middle-a"),
				linked("b", "middle-b"),
				supplied("c", {
					pathType: "leaf_branch",
					contextMode: "compacted",
					startTarget: { kind: "entry", entryId: "middle-b" },
					forkPiEntryId: "middle-b",
				}),
			],
		});
		expect(lineage.ancestry(records[2])).toEqual([
			{ turnRecordId: "b", turnId: "b", boundaryEntryId: "middle-b" },
			{ turnRecordId: "a", turnId: "a", boundaryEntryId: "middle-a" },
		]);
		expect(lineage.origin(records[2]).summary).toContain("Compacted conversation");
	});
	it("keeps missing and ambiguous legacy ownership unknown and does not extend past a result", () => {
		const records = [
			record("a"),
			record("b", { forkPiEntryId: "ambiguous" }),
			record("c", { forkPiEntryId: "later" }),
		];
		const lineage = createInspectionLineage({
			records,
			leases: [],
			observations: [linked("a", "ambiguous"), linked("c", "ambiguous")],
			tree: tree([
				{
					type: "message",
					id: "a-result",
					parentId: null,
					timestamp: "1",
					message: { role: "user", content: "First" },
				},
				{
					type: "message",
					id: "later",
					parentId: "a-result",
					timestamp: "2",
					message: { role: "user", content: "Later" },
				},
			]),
		});
		expect(lineage.origin(records[0]).conversation.state).toBe("not_recorded");
		expect(lineage.origin(records[1]).conversation).toEqual({
			state: "recorded",
			value: { entryId: "ambiguous", turnRecordId: null },
		});
		expect(lineage.owner("later")).toBeNull();
	});
	it("bounds identified legacy messages and preserves ordered blocks without renderer details", () => {
		const execution = record("a");
		const session = tree([
			{
				type: "custom_message",
				id: "prompt",
				parentId: null,
				timestamp: "1",
				customType: "leitwerk",
				content: "Request",
				display: true,
				details: { kind: "turn_prompt", startRecordId: "start-a", private: "renderer" },
			},
			{
				type: "message",
				id: "a-result",
				parentId: "prompt",
				timestamp: "2",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Reason" },
						{ type: "text", text: "Answer" },
						{ type: "toolCall", id: "call", name: "read", arguments: { path: "file" } },
					],
					details: { private: "renderer" },
				},
			},
		]);
		const lineage = createInspectionLineage({
			records: [execution],
			observations: [],
			leases: [],
			tree: session,
		});
		const messages = buildInspectionTraceMessages({
			tree: session,
			record: execution,
			owner: lineage.owner,
			captures: [],
			events: [],
		});
		expect(messages.map((m) => [m.entryId, m.role])).toEqual([
			["prompt", "user"],
			["a-result", "assistant"],
		]);
		expect(messages[1].blocks.map((b) => b.content.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(new Set(messages[1].blocks.map((b) => b.id)).size).toBe(3);
		expect(JSON.stringify(messages)).not.toContain("renderer");
	});
});
