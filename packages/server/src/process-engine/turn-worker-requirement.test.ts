import { describe, expect, it } from "vitest";
import {
	createProcessGraphRegistry,
	createTurnOwnershipFixtureProcess,
} from "../test-helpers/process-fixtures.js";
import { selectedTurnRequiresWorker } from "./turn-worker-requirement.js";

const processId = "worker_requirement_process";
const workerRequirementGraphs = createProcessGraphRegistry([
	createTurnOwnershipFixtureProcess(processId),
]);

describe("selectedTurnRequiresWorker", () => {
	it.each([
		["active LLM turns", processId, "llm_turn", "active", true],
		["active worker-owned automatic turns", processId, "automatic_turn", "active", true],
		["active human turns", processId, "human_turn", "active", false],
		["waiting turns", processId, "llm_turn", "waiting", false],
		["missing selected turns", processId, null, "active", false],
		["unknown active turns", processId, "unknown_turn", "active", true],
		["unknown active processes", "unknown_process", "llm_turn", "active", true],
	] as const)("returns expected worker requirement for %s", (_label, processId, selectedTurnId, lifecycleStatus, expected) => {
		expect(
			selectedTurnRequiresWorker(workerRequirementGraphs, {
				processId,
				selectedTurnId,
				lifecycleStatus,
			}),
		).toBe(expected);
	});
});
