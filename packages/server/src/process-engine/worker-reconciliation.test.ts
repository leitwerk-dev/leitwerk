import { describe, expect, it } from "vitest";
import { createFakeWorkerSupervisor } from "../test-helpers/fake-worker-supervisor.js";
import {
	createProcessGraphRegistry,
	createTurnOwnershipFixtureProcess,
} from "../test-helpers/process-fixtures.js";
import { reconcileWorkerForProcessTurnSelection } from "./worker-reconciliation.js";

const processId = "worker_reconciliation_process";
const instanceId = "proc_1";
const graphAwareRegistry = createProcessGraphRegistry([
	createTurnOwnershipFixtureProcess(processId),
]);

function reconcile(
	initialWorker: boolean,
	change: Parameters<typeof reconcileWorkerForProcessTurnSelection>[4],
) {
	const supervisor = createFakeWorkerSupervisor(initialWorker ? [instanceId] : []);
	return {
		supervisor,
		result: reconcileWorkerForProcessTurnSelection(
			supervisor,
			instanceId,
			processId,
			graphAwareRegistry,
			change,
		),
	};
}

describe("reconcileWorkerForProcessTurnSelection", () => {
	it("does nothing when the selected turn and lifecycle are unchanged", async () => {
		const { supervisor, result } = reconcile(true, {
			fromTurnId: "llm_turn",
			toTurnId: "llm_turn",
			fromLifecycleStatus: "active",
			toLifecycleStatus: "active",
		});

		await result;

		expect(supervisor.callLog).toEqual([]);
	});

	it("stops the worker when the target selection no longer needs one", async () => {
		const { supervisor, result } = reconcile(true, {
			fromTurnId: "llm_turn",
			toTurnId: "human_turn",
			fromLifecycleStatus: "active",
			toLifecycleStatus: "waiting",
		});

		await result;

		expect(supervisor.stopCalls).toEqual([{ instanceId, reason: "turn_changed:human_turn" }]);
	});

	it("spawns a worker when the target selection needs one and none exists", async () => {
		const { supervisor, result } = reconcile(false, {
			fromTurnId: "human_turn",
			toTurnId: "llm_turn",
			fromLifecycleStatus: "waiting",
			toLifecycleStatus: "active",
		});

		await result;

		expect(supervisor.spawnCalls).toEqual([instanceId]);
	});

	it("restarts the worker when switching between active worker-backed turns", async () => {
		const { supervisor, result } = reconcile(true, {
			fromTurnId: "automatic_turn",
			toTurnId: "llm_turn",
			fromLifecycleStatus: "active",
			toLifecycleStatus: "active",
		});

		await result;

		expect(supervisor.callLog).toEqual([
			`stop:${instanceId}:turn_changed:llm_turn`,
			`spawn:${instanceId}`,
		]);
	});

	it.each([
		["server-owned turns", "server_automatic_turn"],
		["human turns", "human_turn"],
	] as const)("stops workers for active %s when a graph is available", async (_label, toTurnId) => {
		const { supervisor, result } = reconcile(true, {
			fromTurnId: "llm_turn",
			toTurnId,
			fromLifecycleStatus: "active",
			toLifecycleStatus: "active",
		});

		await result;

		expect(supervisor.stopCalls).toEqual([{ instanceId, reason: `turn_changed:${toTurnId}` }]);
	});

	it.each([
		["LLM turns", "llm_turn"],
		["worker-owned automatic turns", "automatic_turn"],
	] as const)("starts workers for active %s when a graph is available", async (_label, toTurnId) => {
		const { supervisor, result } = reconcile(false, {
			fromTurnId: "human_turn",
			toTurnId,
			fromLifecycleStatus: "waiting",
			toLifecycleStatus: "active",
		});

		await result;

		expect(supervisor.spawnCalls).toEqual([instanceId]);
	});
});
