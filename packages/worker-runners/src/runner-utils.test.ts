import { describe, expect, it } from "vitest";
import { UnitExitNotifier } from "./runner-utils.js";

describe("UnitExitNotifier", () => {
	it("replays a latched exit to listeners registered after fireExit", async () => {
		const notifier = new UnitExitNotifier();
		const observed: unknown[] = [];

		notifier.fireExit("unit-1", { exitCode: 0, signal: null });
		notifier.onExit("unit-1", (info) => observed.push(info));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(observed).toEqual([{ exitCode: 0, signal: null }]);
	});

	it("only fires a unit exit once", () => {
		const notifier = new UnitExitNotifier();
		const observed: unknown[] = [];
		notifier.onExit("unit-1", (info) => observed.push(info));

		notifier.fireExit("unit-1", { exitCode: 1, signal: null });
		notifier.fireExit("unit-1", { exitCode: 2, signal: null });

		expect(observed).toEqual([{ exitCode: 1, signal: null }]);
	});
});
