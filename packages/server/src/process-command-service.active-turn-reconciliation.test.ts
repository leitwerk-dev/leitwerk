import { automaticTurn, type ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createFakeWorkerSupervisor as createFakeSupervisor } from "./test-helpers/fake-worker-supervisor.js";
import {
	createFixtureProcess,
	createProcessGraphRegistry,
} from "./test-helpers/process-fixtures.js";
import { createTestLlmTurn } from "./test-helpers/turn-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const activeTurnChangeProcess = createFixtureProcess({
	id: "active_turn_change_process",
	entry: "commit_and_merge",
	turns: {
		commit_and_merge: automaticTurn({
			description: "Commit and merge",
			outcomes: {
				commit_required: {
					description: "The worktree must be committed before finalization can continue",
					parameters: {},
					to: "commit_worktree",
				},
			},
			run: () => ({ outcome: "commit_required", params: {} }),
		}),
		commit_worktree: createTestLlmTurn("commit_worktree", {
			committed: {
				description: "The worktree was committed",
				parameters: {},
				to: "commit_and_merge",
			},
		}),
	},
});
const processGraphs = createProcessGraphRegistry([
	activeTurnChangeProcess as ExtensionProcessDefinition<unknown, unknown>,
]);
const processActionRegistry = buildProcessActionRegistry({
	processes: processGraphs,
});

describe("createProcessEngine active-turn reconciliation", () => {
	it("reconciles active automatic -> active llm transitions when a worker already exists", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: activeTurnChangeProcess.id,
			selectedTurnId: "commit_and_merge",
			lifecycleStatus: "active",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			getProcessActionRegistry: () => processActionRegistry,
			async prepareTurnStarts(_current, writes) {
				for (const write of writes.turnStartWrites) {
					if (write.kind !== "create" || write.input.turnType !== "llm") continue;
					write.input.state = {
						kind: "starting",
						start: {
							kind: "llm",
							model: {
								profileId: "fixture-profile",
								providerId: "fixture-provider",
								modelId: "fixture-model",
								thinkingLevel: "off",
							},
							providerOptions: {},
							providerWorkerConfig: null,
							piResourceSnapshotDigest: "fixture-digest",
							workerRuntimeProfileId: "local",
							piSettings: {},
						},
					};
				}
				writes.processPatch.lifecycleStatus = "active";
				writes.workerIntent = { kind: "restart_worker" };
				return { ok: true };
			},
		});

		deps.turnRecords.create({
			instanceId: process.id,
			id: "trn_commit_and_merge_1",
			turnId: "commit_and_merge",
			turnType: "automatic",
			status: "running",
			pathType: "primary",
			forkPiEntryId: null,
		});

		const completed = await commands.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_commit_and_merge_1",
			turnId: "commit_and_merge",
			turnType: "automatic",
			outcome: "commit_required",
			params: {},
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
			turnResultMarkdown: null,
			rootEntryId: null,
		});

		expect(completed.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "commit_worktree",
			lifecycleStatus: "active",
			currentExecution: { kind: "worker_start" },
		});
		expect(supervisor.callLog).toEqual([
			`stop:${process.id}:turn_changed:restart_worker`,
			`spawn:${process.id}`,
		]);
	});
});
