import { describe, expect, it } from "vitest";
import { nextCronOccurrenceUtc } from "./cron.js";

describe("cron utility", () => {
	it("normalizes weekday 7 to sunday", () => {
		const next = nextCronOccurrenceUtc("0 9 * * 7", new Date("2026-04-25T08:45:00.000Z"));
		expect(next).toBe("2026-04-26T09:00:00.000Z");
	});

	it("supports weekday ranges that include sunday as 7", () => {
		const next = nextCronOccurrenceUtc("0 9 * * 6-7", new Date("2026-04-24T08:45:00.000Z"));
		expect(next).toBe("2026-04-25T09:00:00.000Z");
	});

	it("computes the next matching UTC occurrence", () => {
		const next = nextCronOccurrenceUtc("0 9 * * 1-5", new Date("2026-04-24T08:45:00.000Z"));
		expect(next).toBe("2026-04-24T09:00:00.000Z");
	});

	it("moves to the following occurrence when the current time already matches", () => {
		const next = nextCronOccurrenceUtc("0 9 * * 1-5", new Date("2026-04-24T09:00:00.000Z"));
		expect(next).toBe("2026-04-27T09:00:00.000Z");
	});

	it("rejects invalid expressions", () => {
		expect(() => nextCronOccurrenceUtc("0 0 * *")).toThrow(/exactly 5 fields/i);
		expect(() => nextCronOccurrenceUtc("61 0 * * *")).toThrow(/range 0-59/i);
	});
});
