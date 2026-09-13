import { describe, expect, it } from "vitest";
import { groupRetryChains } from "./retry-groups.js";

const attempt = (
	id: string,
	parentTurnRecordId: string | null,
	failed = true,
	turnId = "implement",
) => ({ id, parentTurnRecordId, failed, turnId });
describe("verified retry chains", () => {
	it("groups five preparation failures followed by success without merging three repair cycles", () => {
		const initial = Array.from({ length: 6 }, (_, i) =>
			attempt(`initial-${i}`, i ? `initial-${i - 1}` : null, i < 5),
		);
		const cycles = Array.from({ length: 3 }, (_, i) => [
			attempt(`event-${i}`, null, false, "delivery"),
			attempt(`repair-${i}`, null, false),
		]).flat();
		expect(
			groupRetryChains([...initial, ...cycles], (item) => item).map((group) => group.length),
		).toEqual([6, 1, 1, 1, 1, 1, 1]);
	});
	it("keeps a current failed retry and requires contiguous verified lineage", () => {
		const a = attempt("a", null);
		const b = attempt("b", "a");
		expect(groupRetryChains([a, b], (item) => item)).toEqual([[a, b]]);
		expect(
			groupRetryChains([a, attempt("unrelated", null, false), b], (item) => item),
		).toHaveLength(3);
		expect(groupRetryChains([a, attempt("missing", "absent")], (item) => item)).toHaveLength(2);
		expect(groupRetryChains([attempt("a", null, false), b], (item) => item)).toHaveLength(2);
	});
});
