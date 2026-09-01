import { describe, expect, it } from "vitest";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureAutomaticTurn,
	createFixtureHumanTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { buildTurnSelectionWrites } from "./build-turn-selection-writes.js";

const registry = createDefaultTestProcessGraphRegistry();

function createProcess(
	overrides: Parameters<ReturnType<typeof createTestDeps>["processes"]["create"]>[0],
) {
	return createTestDeps().processes.create({
		processId: "ticket_issue_process",
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		...overrides,
	});
}

describe("buildTurnSelectionWrites", () => {
	it("plans a valid turn selection", () => {
		const process = createProcess({
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const planned = buildTurnSelectionWrites(registry, process, {
			fromTurnId: "generate_plan",
			toTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		expect(planned.events.map((event) => event.eventType)).toEqual(["turn_selected"]);
		expect(planned.workerIntent).toEqual({ kind: "reconcile" });
	});

	it("rejects stale turn changes", () => {
		const process = createProcess({
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const planned = buildTurnSelectionWrites(registry, process, {
			fromTurnId: "implement",
			toTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		expect("ok" in planned).toBe(true);
		if (!("ok" in planned)) return;
		expect(planned.code).toBe("stale_turn");
	});

	it("treats automatic turns as active worker turns", () => {
		const automaticRegistry = createProcessGraphRegistry([
			createFixtureProcess({
				id: "automatic_process",
				entry: "implementation_decision",
				turns: {
					implementation_decision: createFixtureHumanTurn({
						actions: {
							finalize_change: {
								label: "Finalize change",
								acceptanceState: "accepted",
								to: "commit_and_merge",
							},
						},
					}),
					commit_and_merge: createFixtureAutomaticTurn("Commit and merge"),
				},
			}),
		]);
		const process = createTestDeps().processes.create({
			processId: "automatic_process",
			selectedTurnId: "implementation_decision",
			lifecycleStatus: "waiting",
		});

		const planned = buildTurnSelectionWrites(automaticRegistry, process, {
			fromTurnId: "implementation_decision",
			toTurnId: "commit_and_merge",
			trigger: "finalize_change",
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({
			selectedTurnId: "commit_and_merge",
			lifecycleStatus: "active",
		});
	});

	it("supports explicit lifecycle and restart_worker overrides", () => {
		const process = createProcess({
			selectedTurnId: "handoff_review",
			lifecycleStatus: "active",
		});
		const planned = buildTurnSelectionWrites(registry, process, {
			fromTurnId: "handoff_review",
			toTurnId: "run_llm_review",
			lifecycleStatus: "active",
			workerIntent: { kind: "restart_worker" },
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({
			selectedTurnId: "run_llm_review",
		});
		expect(planned.workerIntent).toEqual({ kind: "restart_worker" });
	});

	it("rejects restart_worker when the target selection does not use a worker", () => {
		const process = createProcess({
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		const planned = buildTurnSelectionWrites(registry, process, {
			fromTurnId: "plan_review",
			toTurnId: "plan_review",
			workerIntent: { kind: "restart_worker" },
		});
		expect("ok" in planned).toBe(true);
		if (!("ok" in planned)) return;
		expect(planned.code).toBe("invalid_transition");
	});
});
