import { expect, test } from "vitest";
import { createPollSchedule } from "./poll-loop.js";

test("reserves caller keys before work, using injected time and duration fallback", () => {
	let now = 0;
	const due = createPollSchedule(() => now);
	expect(due("one", "invalid")).toBe(true);
	expect(due("one")).toBe(false);
	expect(due("two", "1s")).toBe(true);
	now = 1000;
	expect(due("two", "1s")).toBe(true);
	expect(due("one")).toBe(false);
	expect(due("one", "30s", 29_999)).toBe(false);
	expect(due("one", "30s", 30_000)).toBe(true);
});
