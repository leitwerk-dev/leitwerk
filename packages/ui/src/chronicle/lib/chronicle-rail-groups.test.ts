import type { ProcessTimelineTurnSummary } from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import {
	buildChronicleRailRows,
	describeRailHistory,
	formatRailElapsed,
} from "./chronicle-rail-groups.js";
import type {
	ChronicleSelectableItem,
	ChronicleSelectableTurnItem,
} from "./chronicle-selectable-items.js";

function history(ids: string[]): ChronicleSelectableTurnItem[] {
	return ids.map((turnId, index) => ({
		kind: "turn",
		anchorId: `turn-${index}`,
		turnRecordId: `record-${index}`,
		turnId,
		title: turnId,
		label: "Turn",
		detail: null,
		hierarchy: "primary",
		tone: "llm_turn",
		markerText: "",
		status: "completed",
		shape: "circle",
	}));
}
const pending: ChronicleSelectableItem = {
	kind: "action",
	anchorId: "action",
	title: "Review",
	label: "Operator decision",
	detail: null,
	hierarchy: "secondary",
	tone: "operator_decision",
	markerText: "",
};

describe("turn rail history", () => {
	it("never folds distinct mapped items but groups retries of one item", () => {
		const items = history(["Investigate", "Investigate", "Investigate", "Investigate"]).map(
			(item, index) => ({
				...item,
				iteration: {
					runId: "run",
					itemKey: ["a", "b", "b", "c"][index] ?? "",
					index: [0, 1, 1, 2][index] ?? 0,
					count: 3,
					label: ["A", "B", "B", "C"][index] ?? "",
				},
			}),
		);
		expect(buildChronicleRailRows([...items, pending]).map((row) => row.kind)).toEqual([
			"item",
			"item",
			"item",
			"item",
			"item",
		]);
		const records = items.map(
			(item, index) =>
				({
					id: item.turnRecordId,
					turnId: item.turnId,
					outcome: index === 1 ? "failed" : "completed",
					parentTurnRecordId: index === 2 ? items[1]?.turnRecordId : null,
					iteration: item.iteration,
				}) as ProcessTimelineTurnSummary,
		);
		const rows = buildChronicleRailRows(items, records);
		expect(rows.map((row) => row.kind)).toEqual(["item", "repeated", "item", "item"]);
		expect(rows[1]).toMatchObject({ retryCount: 2, items: [items[1]] });
		const crossItemRecords = records.map((record, index) =>
			index === 2 && record.iteration
				? { ...record, iteration: { ...record.iteration, itemKey: "c" } }
				: record,
		);
		expect(
			buildChronicleRailRows(items, crossItemRecords).every((row) => row.kind === "item"),
		).toBe(true);
	});
	it("folds complete cycles and leaves the newest result beside its review", () => {
		const items = history([
			"Plan",
			"Implement",
			"Review",
			"Implement",
			"Review",
			"Implement",
			"Review",
			"Implement",
		]);
		const rows = buildChronicleRailRows([...items, pending]);
		expect(rows.map((row) => row.kind)).toEqual(["item", "repeated", "item", "item"]);
		expect(rows[1]).toMatchObject({ sequence: "Implement → Review", items: items.slice(1, 7) });
	});
	it("keeps the current waiting turn outside repeated history", () => {
		const items = history(["Deliver", "Deliver", "Deliver"]);
		items[2].status = "waiting";
		const rows = buildChronicleRailRows(items);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ kind: "repeated", items: items.slice(0, 2) });
		expect(rows[1]).toMatchObject({ kind: "item", item: items[2] });
	});
	it("keeps live, failed, and intervening action rows outside groups", () => {
		const items = history(["Implement", "Review", "Implement", "Review", "Implement"]);
		items[4].status = "in_progress";
		expect(buildChronicleRailRows(items).map((row) => row.kind)).toEqual(["repeated", "item"]);
		items[2].shape = "square";
		expect(buildChronicleRailRows(items)).toMatchObject(
			items.map((item) => ({ kind: "item", item })),
		);
		expect(buildChronicleRailRows([items[0], pending, items[1]])).toMatchObject(
			[items[0], pending, items[1]].map((item) => ({ kind: "item", item })),
		);
	});
	it("matches turn identity rather than labels and leaves partial cycles visible", () => {
		const items = history(["A", "B", "A", "B", "A"]);
		const rows = buildChronicleRailRows(items);
		expect(rows[0]).toMatchObject({ kind: "repeated", items: items.slice(0, 4) });
		expect(rows[1]).toMatchObject({ kind: "item", item: items[4] });
		expect(
			buildChronicleRailRows(
				history(["A", "B", "C", "D"]).map((item) => ({ ...item, title: "Review" })),
			),
		).toHaveLength(4);
	});
	it("supports repeated single turns and separate repeated sequences", () => {
		const rows = buildChronicleRailRows(
			history(["Plan", "Plan", "Implement", "Review", "Implement", "Review"]),
		);
		expect(rows.map((row) => (row.kind === "repeated" ? row.sequence : null))).toEqual([
			"Plan",
			"Implement → Review",
		]);
	});
	it("explains history with recorded event labels, never a guessed repair outcome", () => {
		const items = history(["Deliver", "Implement", "Deliver", "Implement"]);
		items[0].tone = items[2].tone = "external_trigger";
		const group = buildChronicleRailRows(items)[0];
		if (group.kind !== "repeated") throw new Error("Expected history");
		const records = new Map(
			items.map((item) => [
				item.turnRecordId,
				{ summary: "Checks failed" } as ProcessTimelineTurnSummary,
			]),
		);
		expect(describeRailHistory(group, records)).toEqual(["Checks failed (2)"]);
		expect(describeRailHistory(group, new Map())).toEqual([]);
		expect(
			describeRailHistory(
				{ ...group, retryCount: 5 },
				new Map(
					items.map((item) => [
						item.turnRecordId,
						{ outcome: "failed" } as ProcessTimelineTurnSummary,
					]),
				),
			),
		).toEqual(["4 failed attempts"]);
	});
	it("uses recorded elapsed time and omits missing or invalid durations", () => {
		const start = "2026-09-10T12:00:00Z";
		expect(formatRailElapsed(start, "2026-09-10T12:12:14Z")).toBe("12m 14s");
		expect(formatRailElapsed(start, "2026-09-10T13:12:14Z")).toBe("1h 12m 14s");
		expect(formatRailElapsed(start, "2026-09-13T23:13:01Z")).toBe("3d 11h");
		expect(formatRailElapsed(start, start)).toBe("<1s");
		expect(formatRailElapsed(start, null)).toBeNull();
		expect(formatRailElapsed(start, "invalid")).toBeNull();
		expect(formatRailElapsed(start, "2026-09-09T12:00:00Z")).toBeNull();
	});
});
