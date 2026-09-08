import { SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import type { ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { createLaunchCoordinator } from "./launch-coordinator.js";
import { createLaunchPipeline, initialLaunchSteps } from "./launch-pipeline.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { StartProcess } from "./process-engine/ops/start-process.js";
import { commitProcessLaunch } from "./process-launch-executor.js";
import { createServerProcessModelPolicy } from "./process-model-policy/index.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createFakeWorkerSupervisor } from "./test-helpers/fake-worker-supervisor.js";
import {
	createFixtureAutomaticTurn,
	createFixtureHumanTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "./test-helpers/process-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

function setup(startTurnId: string | null = "requested_start") {
	const deps = createTestDeps();
	const processOperations = createProcessOperationCoordinator();
	const supervisor = createFakeWorkerSupervisor();
	const processGraphs = createProcessGraphRegistry([
		createFixtureProcess({
			id: "recovery_demo",
			entry: "default_start",
			alternateEntries: ["requested_start", "review"],
			turns: {
				default_start: createFixtureAutomaticTurn(),
				requested_start: createFixtureAutomaticTurn(),
				review: createFixtureHumanTurn(),
			},
		}),
	]);
	const commands = createProcessEngine({
		...deps,
		processOperations,
		getSupervisor: () => supervisor,
		processGraphs,
		processModelPolicy: createServerProcessModelPolicy({
			config: getDefaultConfig(),
			processGraphs,
			processActionRegistry: { getTurnDefinition: () => undefined },
		}),
	});
	const launcherResolution = vi.fn(() => {
		throw new Error("A committed launch must not resolve or create its process again");
	});
	const coordinator = createLaunchCoordinator({
		...deps,
		commands,
		launcherService: { resolveUiLauncher: launcherResolution } as never,
		futureExecutionLifecycle: {} as never,
		launchPipeline: createLaunchPipeline(deps),
		createProcessFromLaunchPlan: launcherResolution,
	});
	const run = deps.launchRuns.create({
		launcherId: "recovery_demo.ui",
		origin: "ui",
		steps: initialLaunchSteps(),
	});
	const plan: ProcessLaunchPlan = {
		launcherId: "recovery_demo.ui",
		processId: "recovery_demo",
		processInput: {
			processId: "recovery_demo",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			paramsJson: "{}",
			stateJson: "{}",
		},
		projectInputs: [],
		startTurnId,
	};
	// Simulate a crash immediately after process creation, before any launch reactions.
	const { process } = commitProcessLaunch(
		deps,
		plan,
		undefined,
		[],
		undefined,
		run.id,
		undefined,
		SYSTEM_ACTOR,
	);
	return {
		deps,
		commands,
		coordinator,
		process,
		run,
		launcherResolution,
		processOperations,
		supervisor,
	};
}

describe("committed launch recovery", () => {
	it("starts the committed process at its explicit entry without repeating process creation", async () => {
		const { deps, coordinator, process, run, launcherResolution, supervisor } = setup();

		await coordinator.reconcileIncomplete();
		await coordinator.reconcileIncomplete();

		expect(deps.processes.listAll()).toHaveLength(1);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "requested_start",
			lifecycleStatus: "active",
			currentExecution: { kind: "worker_start" },
		});
		expect(deps.turnStarts.listByInstance(process.id)).toHaveLength(1);
		expect(deps.turnRecords.listByInstance(process.id)).toHaveLength(0);
		expect(deps.events.listByInstance(process.id, 10)).toContainEqual(
			expect.objectContaining({
				eventType: "turn_selected",
				data: expect.objectContaining({ actor: SYSTEM_ACTOR }),
			}),
		);
		expect(deps.launchRuns.getById(run.id)?.steps).toContainEqual(
			expect.objectContaining({ id: "create_process", status: "completed" }),
		);
		expect(deps.launchRuns.getReplay(run.id)).toBeNull();
		expect(launcherResolution).not.toHaveBeenCalled();
		expect(supervisor.spawnCalls).toEqual([process.id]);
	});

	it("keeps an already prepared start when recovery replays after start selection", async () => {
		const { deps, commands, coordinator, process, run, supervisor } = setup();
		expect((await commands.startProcess(process.id, "requested_start")).ok).toBe(true);
		const starts = deps.turnStarts.listByInstance(process.id);

		await coordinator.reconcileIncomplete();

		expect(deps.turnStarts.listByInstance(process.id)).toEqual(starts);
		expect(deps.launchRuns.getReplay(run.id)).toBeNull();
		expect(supervisor.spawnCalls).toEqual([process.id]);
	});

	it("completes a committed launch whose plan intentionally has no initial turn", async () => {
		const { deps, coordinator, process, run } = setup(null);

		await coordinator.reconcileIncomplete();

		expect(deps.processes.getById(process.id)).toEqual(process);
		expect(deps.turnStarts.listByInstance(process.id)).toHaveLength(0);
		expect(deps.launchRuns.getById(run.id)?.status).toBe("completed");
		expect(deps.launchRuns.getReplay(run.id)).toBeNull();
	});

	it("completes startup when the requested initial turn waits for human review", async () => {
		const { deps, coordinator, process, run } = setup("review");

		await coordinator.reconcileIncomplete();

		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
			currentExecution: null,
		});
		expect(deps.turnStarts.listByInstance(process.id)).toHaveLength(0);
		expect(deps.launchRuns.getById(run.id)?.status).toBe("completed");
		expect(deps.launchRuns.getReplay(run.id)).toBeNull();
	});

	it("does not reactivate an aborted process while waiting for the process lock", async () => {
		const { deps, commands, process, processOperations } = setup();
		let recovery: ReturnType<typeof commands.run> | undefined;
		await processOperations.runExclusive(process.id, async () => {
			recovery = commands.run(StartProcess, {
				instanceId: process.id,
				startTurnId: "requested_start",
				onlyIfUnstarted: true,
			});
			deps.processes.update(process.id, { lifecycleStatus: "aborted" });
		});

		expect(await recovery).toMatchObject({ ok: true });
		expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("aborted");
		expect(deps.turnStarts.listByInstance(process.id)).toHaveLength(0);
	});
});
