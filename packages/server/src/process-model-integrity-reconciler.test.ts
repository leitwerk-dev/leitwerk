import type { ProcessInstance } from "@leitwerk-dev/domain";
import { describe, expect, it, vi } from "vitest";
import { reconcilePersistedProcessModelIntegrity } from "./process-model-integrity-reconciler.js";
import { createTestModelPolicy } from "./test-helpers/process-model-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

describe("persisted process model startup reconciliation", () => {
	it("parks malformed open processes without rewriting their model state", async () => {
		const deps = createTestDeps();
		const { policy } = createTestModelPolicy();
		const process = deps.processes.create({
			processId: "policy",
			selectedTurnId: "run",
			lifecycleStatus: "waiting",
			turnConfigsJson: JSON.stringify({ run: [] }),
			defaultModelProfileId: "removed",
		});
		const park = vi.fn(async (instanceId: string) => {
			deps.processes.update(instanceId, { lifecycleStatus: "error" });
			return {
				ok: true as const,
				process: deps.processes.getById(instanceId) as ProcessInstance,
				data: undefined,
			};
		});

		await reconcilePersistedProcessModelIntegrity({
			processes: deps.processes,
			commands: { parkProcessLifecycle: park },
			policy,
		});

		expect(park).toHaveBeenCalledWith(process.id, {
			reason: "Persisted model state is malformed (invalid_turn_configs_json)",
		});
		expect(deps.processes.getById(process.id)).toMatchObject({
			lifecycleStatus: "error",
			turnConfigsJson: JSON.stringify({ run: [] }),
			defaultModelProfileId: "removed",
		});
	});

	it("leaves valid missing-profile state and closed processes unchanged", async () => {
		const deps = createTestDeps();
		const { policy } = createTestModelPolicy({ profiles: [{ id: "available" }] });
		const valid = deps.processes.create({
			processId: "policy",
			selectedTurnId: "run",
			lifecycleStatus: "active",
			defaultModelProfileId: "missing",
			turnConfigsJson: JSON.stringify({ run: { modelProfileId: "missing" } }),
		});
		deps.processes.create({
			processId: "policy",
			selectedTurnId: "run",
			lifecycleStatus: "completed",
			turnConfigsJson: JSON.stringify({ run: [] }),
		});
		const park = vi.fn();

		await reconcilePersistedProcessModelIntegrity({
			processes: deps.processes,
			commands: { parkProcessLifecycle: park },
			policy,
		});

		expect(park).not.toHaveBeenCalled();
		expect(deps.processes.getById(valid.id)?.lifecycleStatus).toBe("active");
	});

	it("is idempotent for processes already parked in error", async () => {
		const deps = createTestDeps();
		const { policy } = createTestModelPolicy();
		deps.processes.create({
			processId: "policy",
			selectedTurnId: "run",
			lifecycleStatus: "error",
			turnConfigsJson: JSON.stringify({ run: [] }),
		});
		const park = vi.fn();

		await reconcilePersistedProcessModelIntegrity({
			processes: deps.processes,
			commands: { parkProcessLifecycle: park },
			policy,
		});

		expect(park).not.toHaveBeenCalled();
	});
});
