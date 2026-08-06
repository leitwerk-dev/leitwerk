import { describe, expect, it } from "vitest";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import {
	applyFutureExecutionTransitionPlan,
	planAdvanceFutureExecution,
	planCancelScheduledAction,
	planConsumeFutureExecution,
	planRetryFutureExecution,
} from "./transition-planner.js";

function createExecution() {
	const deps = createTestDeps();
	const process = deps.processes.create({ processId: "planner" });
	const execution = deps.futureExecutions.create({
		kind: "action",
		scheduleKind: "once",
		processId: process.processId,
		instanceId: process.id,
		actionId: "approve",
		payloadJson: "{}",
		nextRunAt: "2026-04-25T10:00:00.000Z",
	});
	return { deps, process, execution };
}

describe("future execution transition planner", () => {
	it("consumes only the expected occurrence", () => {
		const { deps, execution } = createExecution();
		const plan = planConsumeFutureExecution(execution);
		deps.futureExecutions.update(execution.id, {
			nextRunAt: "2026-04-25T11:00:00.000Z",
		});

		expect(applyFutureExecutionTransitionPlan(deps.futureExecutions, plan)).toEqual({
			kind: "stale",
		});
		expect(deps.futureExecutions.getById(execution.id)).not.toBeNull();
	});

	it("advances and retries the expected occurrence", () => {
		const { deps, execution } = createExecution();
		const advanced = applyFutureExecutionTransitionPlan(
			deps.futureExecutions,
			planAdvanceFutureExecution(execution, "2026-04-26T10:00:00.000Z"),
		);
		expect(advanced).toMatchObject({
			kind: "applied",
			execution: { nextRunAt: "2026-04-26T10:00:00.000Z" },
		});
		if (advanced.kind !== "applied" || !advanced.execution) return;
		expect(
			applyFutureExecutionTransitionPlan(
				deps.futureExecutions,
				planRetryFutureExecution(advanced.execution, "2026-04-26T10:01:00.000Z"),
			),
		).toMatchObject({
			kind: "applied",
			execution: { nextRunAt: "2026-04-26T10:01:00.000Z" },
		});
	});

	it("cancels only the scheduled action for the expected process", () => {
		const { deps, process, execution } = createExecution();
		const wrong = planCancelScheduledAction(execution, "other");
		expect(wrong).toBeNull();
		const plan = planCancelScheduledAction(execution, process.id);
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(applyFutureExecutionTransitionPlan(deps.futureExecutions, plan).kind).toBe("applied");
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
	});
});
