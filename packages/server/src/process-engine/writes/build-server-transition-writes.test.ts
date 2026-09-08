import { describe, expect, it } from "vitest";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureAutomaticTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { buildServerTransitionWrites } from "./build-server-transition-writes.js";

const registry = createDefaultTestProcessGraphRegistry();
const implementationState = { readyForHumanReview: true };

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

describe("buildServerTransitionWrites", () => {
	it("maps explicit restart_worker transitions", () => {
		const process = createProcess({
			selectedTurnId: "handoff_review",
			lifecycleStatus: "active",
		});
		const planned = buildServerTransitionWrites(registry, process, {
			turnId: "run_llm_review",
			state: implementationState,
			effect: { runtime: "restart_worker" },
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({
			selectedTurnId: "run_llm_review",
			stateJson: JSON.stringify(implementationState),
		});
		expect(planned.workerIntent).toEqual({ kind: "restart_worker" });
	});

	it("re-enters a waiting worker automatic turn when it is selected again", () => {
		const automaticRegistry = createProcessGraphRegistry([
			createFixtureProcess({
				id: "automatic_reentry_process",
				entry: "automatic_turn",
				turns: { automatic_turn: createFixtureAutomaticTurn() },
			}),
		]);
		const process = createTestDeps().processes.create({
			processId: "automatic_reentry_process",
			selectedTurnId: "automatic_turn",
			lifecycleStatus: "waiting",
		});

		const planned = buildServerTransitionWrites(automaticRegistry, process, {
			turnId: "automatic_turn",
			state: implementationState,
			trigger: "external_event_received",
		});

		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch).toMatchObject({
			lifecycleStatus: "active",
			stateJson: JSON.stringify(implementationState),
			currentExecution: {
				kind: "worker_start",
			},
		});
		expect(planned.turnStartWrites).toHaveLength(1);
		expect(planned.workerIntent).toEqual({ kind: "reconcile" });
	});

	it("supports runtime effects without a turn change", () => {
		const process = createProcess({
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});
		const planned = buildServerTransitionWrites(registry, process, {
			state: { readyForHumanReview: true },
			effect: { runtime: "restart_worker" },
		});
		expect("ok" in planned).toBe(false);
		if ("ok" in planned) return;
		expect(planned.processPatch.stateJson).toBe(JSON.stringify({ readyForHumanReview: true }));
		expect(planned.workerIntent).toEqual({ kind: "restart_worker" });
	});
});
