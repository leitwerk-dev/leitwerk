import { describe, expect, it } from "vitest";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureAutomaticTurn,
	createFixtureHumanTurn,
	createFixtureProcess,
	createFixtureServerAutomaticProcess,
	createProcessGraphRegistry,
} from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { buildTurnSelectionWrites } from "./build-turn-selection-writes.js";

const registry = createDefaultTestProcessGraphRegistry();
const planReviewStateJson = JSON.stringify({ reviewSubject: { kind: "plan" } });
const implementationReviewStateJson = JSON.stringify({ reviewSubject: { kind: "implementation" } });

function createProcess(
	overrides: Parameters<ReturnType<typeof createTestDeps>["processes"]["create"]>[0],
) {
	return createTestDeps().processes.create({
		processId: "jira_issue_process",
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
			stateJson: planReviewStateJson,
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
			stateJson: planReviewStateJson,
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
						reviewSubject: { kind: "implementation" },
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
			stateJson: implementationReviewStateJson,
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
			stateJson: implementationReviewStateJson,
		});
		const planned = buildTurnSelectionWrites(registry, process, {
			fromTurnId: "handoff_review",
			toTurnId: "run_llm_review",
			lifecycleStatus: "active",
			workerIntent: { kind: "restart_worker" },
			state: { reviewSubject: { kind: "implementation" } },
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
			stateJson: planReviewStateJson,
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

	it("rejects restart_worker for active server-owned turns", () => {
		const serverOwnedRegistry = createProcessGraphRegistry([
			createFixtureServerAutomaticProcess({ id: "server_owned_turn_selection_process" }),
		]);
		const process = createTestDeps().processes.create({
			processId: "server_owned_turn_selection_process",
			selectedTurnId: "server_auto",
			lifecycleStatus: "active",
		});

		const planned = buildTurnSelectionWrites(serverOwnedRegistry, process, {
			fromTurnId: "server_auto",
			toTurnId: "server_auto",
			lifecycleStatus: "active",
			workerIntent: { kind: "restart_worker" },
		});

		expect("ok" in planned).toBe(true);
		if (!("ok" in planned)) return;
		expect(planned.code).toBe("invalid_transition");
	});

	it("rejects direct review transitions when no reviewSubject is available", () => {
		const process = createProcess({
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const planned = buildTurnSelectionWrites(registry, process, {
			fromTurnId: "generate_plan",
			toTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		expect("ok" in planned).toBe(true);
		if (!("ok" in planned)) return;
		expect(planned.code).toBe("invalid_transition");
		expect(planned.message).toContain("requires reviewSubject.kind 'plan'");
	});
});
