import {
	type Codec,
	defineProcess,
	humanTurn,
	type StructuralProcessState,
	serverAutomaticTurn,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import {
	createStructuralProcessState,
	structuralProcessStateCodec,
} from "./test-helpers/structural-process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const emptyCodec: Codec<Record<string, never>> = {
	parse() {
		return {};
	},
	serialize(value) {
		return value;
	},
};

const testProcess = defineProcess<Record<string, never>, StructuralProcessState>({
	id: "test_process",
	displayName: "Test Process",
	entry: "await_project_update",
	paramsCodec: emptyCodec,
	stateCodec: structuralProcessStateCodec,
	initialState() {
		return createStructuralProcessState();
	},
	turns: {
		await_project_update: humanTurn({
			description: "Wait for project metadata",
			reviewSubject: { kind: "plan" },
			actions: {
				project_metadata_synced: {
					label: "Project metadata synced",
					acceptanceState: "accepted",
					externalTriggers: [
						{
							id: "project_metadata_webhook",
							label: "Project metadata webhook",
							description: "External integration notifies that project metadata changed.",
						},
					],
					to: "check_review_ready",
				},
			},
		}),
		check_review_ready: serverAutomaticTurn<
			Record<string, never>,
			StructuralProcessState,
			"ready" | "waiting"
		>({
			description: "Check whether review is ready",
			run(ctx) {
				if (!ctx.projects.every((project) => project.externalId !== null)) {
					return { outcome: "waiting", params: {} };
				}
				return {
					outcome: "ready",
					params: {},
					state: { ...ctx.state, reviewSubject: { kind: "implementation" } },
				};
			},
			outcomes: {
				ready: { description: "Ready for review", parameters: {}, to: "implementation_review" },
				waiting: { description: "Still waiting", parameters: {}, to: "await_project_update" },
			},
		}),
		implementation_review: humanTurn({
			description: "Implementation review",
			reviewSubject: { kind: "implementation" },
			actions: {
				ack_review: { label: "Acknowledge", acceptanceState: "accepted", complete: true },
			},
		}),
	},
});

describe("explicit readiness turn integration", () => {
	it("routes an external integration action through a readiness gate", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "test_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "await_project_update",
			stateJson: JSON.stringify({
				...createStructuralProcessState(),
				reviewSubject: { kind: "plan" },
			}),
		});
		const project = deps.projects.create({
			instanceId: process.id,
			key: "svc-a",
			repoLocator: "https://example.invalid/svc-a.git",
			baseBranch: "main",
			workBranch: "feature/test",
		});
		deps.projects.update(project.id, { externalId: "42" });
		const registry = buildProcessActionRegistry({
			processes: new Map([["test_process", testProcess]]),
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			broadcaster: deps.broadcaster,
			getSupervisor: () => undefined,
			processGraphs: new Map([["test_process", testProcess]]),
			getProcessActionRegistry: () => registry,
		});

		const dispatched = await commands.executeProcessAction(
			process.id,
			"project_metadata_synced",
			{ projectId: project.id },
			{ source: "external" },
		);

		expect(dispatched).toMatchObject({ ok: true });
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "check_review_ready",
			lifecycleStatus: "active",
		});

		await commands.drainServerAutomaticTurns(process.id);

		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "implementation_review",
			lifecycleStatus: "waiting",
		});
	});
});
