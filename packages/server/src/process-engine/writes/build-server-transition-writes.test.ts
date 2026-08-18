import { describe, expect, it } from "vitest";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureServerAutomaticProcess,
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

	it("rejects restart_worker for active server-owned turns", () => {
		const serverOwnedRegistry = createProcessGraphRegistry([
			createFixtureServerAutomaticProcess({ id: "server_owned_transition_process" }),
		]);
		const process = createTestDeps().processes.create({
			processId: "server_owned_transition_process",
			selectedTurnId: "server_auto",
			lifecycleStatus: "active",
		});

		const planned = buildServerTransitionWrites(serverOwnedRegistry, process, {
			effect: { runtime: "restart_worker" },
		});

		expect("ok" in planned).toBe(true);
		if (!("ok" in planned)) return;
		expect(planned.code).toBe("invalid_transition");
	});
});
