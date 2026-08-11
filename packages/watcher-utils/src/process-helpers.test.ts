import type { ProcessInstance } from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { ensureWorkerForActiveAgent, processNeedsWorker } from "./process-helpers.js";

function makeProcess(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	return {
		id: "agt_1",
		processId: "ticket_issue_process",
		selectedTurnId: null,
		lifecycleStatus: "discovered",
		currentExecution: null,
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		modelProfileId: null,
		paramsJson: null,
		stateJson: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe("process-helpers", () => {
	it("treats only active processes with a selected turn as worker-runnable", () => {
		expect(
			processNeedsWorker(
				makeProcess({ selectedTurnId: "generate_plan", lifecycleStatus: "active" }),
			),
		).toBe(true);
		expect(
			processNeedsWorker(makeProcess({ selectedTurnId: null, lifecycleStatus: "active" })),
		).toBe(false);
		expect(
			processNeedsWorker(
				makeProcess({ selectedTurnId: "generate_plan", lifecycleStatus: "waiting" }),
			),
		).toBe(false);
	});

	it("does not spawn a worker when the process is active but has no selected turn", async () => {
		const spawned: string[] = [];
		const events: Array<{ instanceId: string; eventType: string; data?: Record<string, unknown> }> =
			[];

		await ensureWorkerForActiveAgent(
			{
				events: {
					create(input) {
						events.push(input);
					},
					listByInstance() {
						return [];
					},
				},
				supervisor: {
					async spawnWorker(instanceId) {
						spawned.push(instanceId);
					},
					getWorker() {
						return undefined;
					},
				},
			},
			makeProcess({ selectedTurnId: null, lifecycleStatus: "active" }),
		);

		expect(spawned).toEqual([]);
		expect(events).toEqual([]);
	});
});
