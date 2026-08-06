import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { getProcessGraph } from "../../process-graph.js";
import { createProcessOperationCoordinator } from "../../process-operation-coordinator.js";
import type { WorkerSupervisor } from "../../supervisor/worker-supervisor.js";
import { createFakeWorkerSupervisor } from "../../test-helpers/fake-worker-supervisor.js";
import { createDefaultTestProcessGraphRegistry } from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { createProcessEngine } from "../engine.js";

const processGraphs = createDefaultTestProcessGraphRegistry();
getProcessGraph(processGraphs, "jira_issue_process");

function createEngine(
	deps: ReturnType<typeof createTestDeps>,
	getSupervisor: () => WorkerSupervisor | undefined,
) {
	return createProcessEngine({
		...deps,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor,
		processGraphs,
	});
}

// A process parked in `error` fails the lifecycle check, but a missing supervisor
// must be reported first so the failure precedence matches the pre-engine route
// contract (503 supervisor-unavailable outranks the 400 invalid-state error).
describe("AbortTurn failure precedence", () => {
	it("reports supervisor unavailability before the lifecycle state check", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
		});
		const commands = createEngine(deps, () => undefined);

		const result = await commands.abortTurn(process.id, { actor: ADMIN_ACTOR });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("worker_supervisor_unavailable");
	});

	it("rejects an inactive process with a supervisor present", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
		});
		const supervisor = createFakeWorkerSupervisor();
		const commands = createEngine(deps, () => supervisor);

		const result = await commands.abortTurn(process.id, { actor: ADMIN_ACTOR });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid_transition");
	});
});
