import { describe, expect, it } from "vitest";
import type { FutureExecutionSummary } from "./api.js";
import { upsertFutureExecutionSummary } from "./future-executions-logic.js";

function launch(
	id: string,
	overrides: Partial<FutureExecutionSummary> = {},
): FutureExecutionSummary {
	return {
		id,
		kind: "launch",
		scheduleKind: "once",
		processId: "mr_polish_process",
		nextRunAt: "2026-01-01T13:05:00.000Z",
		cronExpression: null,
		instanceId: null,
		title: `Launch ${id}`,
		launcherId: "mr-polish",
		launcherLabel: "MR polish",
		initialPromptPreview: null,
		...overrides,
	};
}

describe("upsertFutureExecutionSummary", () => {
	it("prepends a new future execution so detail routes can render immediately", () => {
		const existing = launch("fut_existing");
		const inserted = launch("fut_new");

		expect(upsertFutureExecutionSummary([existing], inserted)).toEqual([inserted, existing]);
	});

	it("replaces an existing future execution without reordering surrounding entries", () => {
		const first = launch("fut_1");
		const updated = launch("fut_2", { title: "Updated launch" });
		const third = launch("fut_3");

		expect(upsertFutureExecutionSummary([first, launch("fut_2"), third], updated)).toEqual([
			first,
			updated,
			third,
		]);
	});
});
