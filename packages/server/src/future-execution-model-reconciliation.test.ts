import { serializeFutureLaunchPayload } from "@leitwerk-dev/protocol";
import { describe, expect, it, vi } from "vitest";
import { projectLaunchPlanModelState } from "./future-execution/model-projection.js";
import { reconcileFutureExecutionModelBlocks } from "./future-execution/reconciliation.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import {
	createModelAvailabilitySnapshot,
	createTestLaunchPlan,
	createTestModelPolicy,
} from "./test-helpers/process-model-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

function availability(value: "available" | "unavailable", revision: number) {
	return createModelAvailabilitySnapshot(
		[{ profileId: "first", modelId: "one", availability: value }],
		revision,
	);
}

function scheduleLaunch(deps: ReturnType<typeof createTestDeps>) {
	return deps.futureExecutions.create({
		kind: "launch",
		scheduleKind: "once",
		processId: "policy",
		launcherId: "policy.launcher",
		payloadJson: serializeFutureLaunchPayload({
			launcherInput: {},
			modelConfig: {},
			launchPlan: createTestLaunchPlan({
				processInput: { selectedTurnId: null, paramsJson: "{}", stateJson: "{}" },
			}),
		}),
		nextRunAt: "2027-01-01T00:00:00.000Z",
	});
}

describe("future execution lifecycle model reconciliation", () => {
	it("strictly blocks malformed launch model configuration without a synthetic availability revision", () => {
		const { policy } = createTestModelPolicy();
		const result = projectLaunchPlanModelState(
			createTestLaunchPlan({ processInput: { turnConfigsJson: "not-json" } }),
			{
				policy,
				availability: availability("available", 7),
			},
		);

		expect(result.modelSelection).toBeNull();
		expect(result.blockedReason).toMatchObject({ code: "invalid_model_configuration" });
		expect(result.blockedReason).not.toHaveProperty("availabilityRevision");
	});

	it("backfills null selections, emits updates, and preserves an unchanged detectedAt", async () => {
		const deps = createTestDeps();
		const {
			policy,
			graph,
			processActionRegistry: registry,
		} = createTestModelPolicy({ profiles: [{ id: "first", model_id: "one" }] });
		const execution = scheduleLaunch(deps);
		const broadcast = vi.spyOn(deps.broadcaster, "broadcast");
		let currentAvailability = availability("unavailable", 1);
		const base = {
			futureExecutions: deps.futureExecutions,
			processes: deps.processes,
			projects: deps.projects,
			turnRecords: deps.turnRecords,
			processGraphs: graph,
			processActionRegistry: registry,
			processOperations: createProcessOperationCoordinator(),
			policy,
			getModelAvailabilitySnapshot: () => currentAvailability,
			broadcaster: deps.broadcaster,
			asOf: "2026-04-25T10:00:00.000Z",
		};
		await reconcileFutureExecutionModelBlocks({
			...base,
			availability: availability("unavailable", 1),
		});
		const blocked = deps.futureExecutions.getById(execution.id);
		expect(blocked).toMatchObject({
			modelSelection: { modelProfileId: "first", provenance: { kind: "inherited" } },
			blockedReason: { code: "model_unavailable" },
		});
		const detectedAt = blocked?.blockedReason?.detectedAt;
		const calls = broadcast.mock.calls.length;
		await reconcileFutureExecutionModelBlocks({
			...base,
			availability: availability("unavailable", 1),
		});
		expect(deps.futureExecutions.getById(execution.id)?.blockedReason?.detectedAt).toBe(detectedAt);
		expect(broadcast).toHaveBeenCalledTimes(calls);
		currentAvailability = availability("available", 2);
		await reconcileFutureExecutionModelBlocks({
			...base,
			availability: currentAvailability,
		});
		expect(deps.futureExecutions.getById(execution.id)?.blockedReason).toBeNull();
		expect(broadcast.mock.calls.length).toBeGreaterThan(calls);
	});

	it("parks a typed stale-snapshot block when the availability revision changes twice", async () => {
		const deps = createTestDeps();
		const {
			policy,
			graph,
			processActionRegistry: registry,
		} = createTestModelPolicy({ profiles: [{ id: "first", model_id: "one" }] });
		const execution = scheduleLaunch(deps);
		const currentSnapshots = [availability("available", 2), availability("available", 3)];
		let snapshotIndex = 0;

		await reconcileFutureExecutionModelBlocks({
			futureExecutions: deps.futureExecutions,
			processes: deps.processes,
			projects: deps.projects,
			turnRecords: deps.turnRecords,
			processGraphs: graph,
			processActionRegistry: registry,
			processOperations: createProcessOperationCoordinator(),
			policy,
			availability: availability("unavailable", 1),
			getModelAvailabilitySnapshot: () =>
				currentSnapshots[
					Math.min(snapshotIndex++, currentSnapshots.length - 1)
				] as (typeof currentSnapshots)[number],
			broadcaster: deps.broadcaster,
			asOf: "2026-04-25T10:00:00.000Z",
		});

		expect(deps.futureExecutions.getById(execution.id)).toMatchObject({
			modelSelection: null,
			blockedReason: {
				code: "stale_evaluation_snapshot",
				availabilityRevision: 3,
			},
		});
	});
});
