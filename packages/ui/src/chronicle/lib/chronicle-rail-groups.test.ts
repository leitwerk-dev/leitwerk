import { describe, expect, it } from "vitest";
import { buildChronicleRailRows, formatRailElapsed } from "./chronicle-rail-groups.js";
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
	it("keeps live, failed, and intervening action rows outside groups", () => {
		const items = history(["Implement", "Review", "Implement", "Review", "Implement"]);
		items[4].status = "in_progress";
		expect(buildChronicleRailRows(items).map((row) => row.kind)).toEqual(["repeated", "item"]);
		items[2].shape = "square";
		expect(buildChronicleRailRows(items).every((row) => row.kind === "item")).toBe(true);
		expect(
			buildChronicleRailRows([items[0], pending, items[1]]).every((row) => row.kind === "item"),
		).toBe(true);
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
	it("uses recorded elapsed time and omits missing or invalid durations", () => {
		const start = "2026-09-10T12:00:00Z";
		expect(formatRailElapsed(start, "2026-09-10T12:12:14Z")).toBe("12m 14s");
		expect(formatRailElapsed(start, "2026-09-10T13:12:14Z")).toBe("1h 12m 14s");
		expect(formatRailElapsed(start, start)).toBe("<1s");
		expect(formatRailElapsed(start, null)).toBeNull();
		expect(formatRailElapsed(start, "invalid")).toBeNull();
		expect(formatRailElapsed(start, "2026-09-09T12:00:00Z")).toBeNull();
	});
});
