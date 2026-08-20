import { defineProcess, humanTurn, type ProcessLaunchPlan } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { planConsumeFutureExecution } from "./future-execution/transition-planner.js";
import {
	buildProcessLaunchPostCommitEffects,
	commitProcessLaunch,
	createProcessFromLaunchConfig,
	createProcessFromLaunchPlan,
	createScheduledProcessFromLaunchPlan,
} from "./process-launch-executor.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

function withStartFailure(deps: ReturnType<typeof createTestDeps>) {
	return {
		...deps,
		commands: {
			async startProcess() {
				return {
					ok: false as const,
					code: "operation_failed" as const,
					message: "Process operation failed before commit",
					stage: "pre_commit" as const,
				};
			},
		} as never,
	};
}

function createLaunchPlan(): ProcessLaunchPlan {
	return {
		launcherId: "demo.launcher",
		processId: "demo_process",
		processInput: {
			processId: "demo_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
			paramsJson: "{}",
			stateJson: "{}",
		},
		projectInputs: [
			{
				key: "app",
				repoLocator: "https://example.com/app.git",
				baseBranch: "main",
				workBranch: "feature/demo",
			},
		],
		startTurnId: null,
	};
}

describe("process launch durable boundary", () => {
	it("rejects watcher-selected skills that are unknown or inactive before creation", async () => {
		const deps = createTestDeps();
		const result = await createProcessFromLaunchPlan(deps, {
			...createLaunchPlan(),
			skillIds: ["missing-skill"],
		});

		expect(result).toMatchObject({
			ok: false,
			stage: "pre_commit",
			status: 400,
			body: { error: "Unknown or unavailable skill 'missing-skill'" },
		});
		expect(deps.processes.listAll()).toHaveLength(0);
	});

	it("builds and executes a canonical config through the target codecs", async () => {
		const deps = createTestDeps();
		const processDef = defineProcess({
			id: "configured_process",
			displayName: "Configured",
			entry: "review",
			paramsCodec: {
				parse: (value) => ({ prompt: (value as { prompt: string }).prompt.trim() }),
				serialize: (value: { prompt: string }) => value,
			},
			stateCodec: {
				parse: (value) => ({
					initializedFrom: (value as { initializedFrom: string }).initializedFrom.toUpperCase(),
				}),
				serialize: (value: { initializedFrom: string }) => value,
			},
			initialState: (params) => ({ initializedFrom: params.prompt.trim() }),
			turns: {
				review: humanTurn({
					description: "Review",
					actions: { complete: { label: "Complete", complete: true } },
				}),
			},
		});

		const result = await createProcessFromLaunchConfig(
			{ ...deps, processDefinitions: new Map([[processDef.id, processDef]]) },
			{
				launcherId: "configured_process.imported",
				handoffDedupKey: "source:one",
				launchConfig: {
					processId: processDef.id,
					params: { prompt: "  Fix it  " },
					metadata: { source: "analysis" },
					projects: [
						{
							key: "repo",
							repoLocator: "./repo",
							baseBranch: "main",
							workBranch: null,
						},
					],
				},
			},
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(JSON.parse(result.process.paramsJson ?? "{}")).toEqual({ prompt: "Fix it" });
		expect(JSON.parse(result.process.stateJson ?? "{}")).toEqual({ initializedFrom: "FIX IT" });
		expect(result.process.metadata).toEqual({
			source: "analysis",
			launcherId: "configured_process.imported",
		});
		expect(result.projects).toEqual([
			expect.objectContaining({ key: "repo", repoLocator: "./repo", workBranch: null }),
		]);
		expect(deps.handoffDedupKeys.getByKey("source:one")).toMatchObject({
			instanceId: result.process.id,
		});
	});

	it("commits process and projects in one durable transaction", () => {
		const deps = createTestDeps();
		const launchPlan = createLaunchPlan();

		const commit = commitProcessLaunch(deps, launchPlan);

		expect(deps.processes.getById(commit.process.id)).toEqual(commit.process);
		expect(deps.projects.listByInstance(commit.process.id)).toEqual(commit.projects);
		expect(commit.projects).toHaveLength(1);
	});

	it("uses pinned resource selections for scheduled launches without a skill resolver", async () => {
		const deps = createTestDeps();
		const execution = deps.futureExecutions.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "demo_process",
			launcherId: "demo.launcher",
			payloadJson: "{}",
			nextRunAt: "2026-04-25T10:00:00.000Z",
		});
		const result = await createScheduledProcessFromLaunchPlan(
			deps,
			{ ...createLaunchPlan(), skillIds: ["missing-skill"] },
			planConsumeFutureExecution(execution),
			{ resourceSelections: [] },
		);

		expect(result.ok).toBe(true);
		expect(deps.processes.listAll()).toHaveLength(1);
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
	});

	it("commits scheduled process creation and occurrence consumption atomically", () => {
		const deps = createTestDeps();
		const execution = deps.futureExecutions.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "demo_process",
			launcherId: "demo.launcher",
			payloadJson: "{}",
			nextRunAt: "2026-04-25T10:00:00.000Z",
		});

		const commit = commitProcessLaunch(
			deps,
			createLaunchPlan(),
			planConsumeFutureExecution(execution),
		);

		expect(deps.processes.getById(commit.process.id)).toEqual(commit.process);
		expect(deps.futureExecutions.getById(execution.id)).toBeNull();
	});

	it("rolls process creation back when the scheduled occurrence is stale", () => {
		const deps = createTestDeps();
		const execution = deps.futureExecutions.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "demo_process",
			launcherId: "demo.launcher",
			payloadJson: "{}",
			nextRunAt: "2026-04-25T10:00:00.000Z",
		});
		const plan = planConsumeFutureExecution(execution);
		deps.futureExecutions.update(execution.id, {
			nextRunAt: "2026-04-25T11:00:00.000Z",
		});

		expect(() => commitProcessLaunch(deps, createLaunchPlan(), plan)).toThrow(
			"Future execution changed",
		);
		expect(deps.processes.listAll()).toHaveLength(0);
		expect(deps.futureExecutions.getById(execution.id)).not.toBeNull();
	});

	it("persists handoff dedup keys and reuses the claimed process", () => {
		const deps = createTestDeps();
		const launchPlan = {
			...createLaunchPlan(),
			handoffDedupKey: "process-analysis:agt_analysis:local-repo-change",
		};

		const first = commitProcessLaunch(deps, launchPlan);
		const second = commitProcessLaunch(deps, launchPlan);

		expect(second).toMatchObject({
			process: first.process,
			projects: first.projects,
			dedupReused: true,
		});
		expect(deps.processes.listAll()).toHaveLength(1);
		expect(deps.handoffDedupKeys.getByKey(launchPlan.handoffDedupKey)).toMatchObject({
			instanceId: first.process.id,
		});
	});

	it("reports deduped start failures instead of swallowing them", async () => {
		const deps = createTestDeps();
		const launchPlan = {
			...createLaunchPlan(),
			startTurnId: "run",
			handoffDedupKey: "process-analysis:agt_analysis:local-repo-change",
		};
		commitProcessLaunch(deps, launchPlan);

		const result = await createProcessFromLaunchPlan(withStartFailure(deps), launchPlan);

		expect(result).toMatchObject({
			ok: false,
			stage: "post_commit",
			status: 500,
			body: expect.objectContaining({ code: "operation_failed" }),
		});
		expect(deps.processes.listAll()).toHaveLength(1);
	});

	it("persists launch project metadata as part of project creation", () => {
		const deps = createTestDeps();
		const launchPlan = createLaunchPlan();
		launchPlan.projectInputs[0] = {
			...launchPlan.projectInputs[0],
			externalId: "mr-123",
			externalUrl: "https://codehost.example.com/team/app/-/merge_requests/123",
			metadata: { source: "watcher" },
		};

		const commit = commitProcessLaunch(deps, launchPlan);

		expect(commit.projects[0]).toMatchObject({
			externalId: "mr-123",
			externalUrl: "https://codehost.example.com/team/app/-/merge_requests/123",
			metadata: { source: "watcher" },
		});
		expect(deps.projects.listByInstance(commit.process.id)[0]).toMatchObject({
			externalId: "mr-123",
			externalUrl: "https://codehost.example.com/team/app/-/merge_requests/123",
			metadata: { source: "watcher" },
		});
	});

	it("describes broadcasts and title work as post-commit effects", () => {
		const deps = createTestDeps();
		const launchPlan = createLaunchPlan();
		const commit = commitProcessLaunch(deps, launchPlan);

		const effects = buildProcessLaunchPostCommitEffects(commit, launchPlan);

		expect(effects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "broadcast",
					frame: expect.objectContaining({
						type: "process.created",
						instanceId: commit.process.id,
					}),
				}),
				expect.objectContaining({
					kind: "broadcast",
					frame: expect.objectContaining({
						type: "project.updated",
						instanceId: commit.process.id,
						payload: expect.objectContaining({
							projectId: "app",
						}),
					}),
				}),
				{ kind: "queue_process_title", processId: commit.process.id, launchPlan },
				expect.objectContaining({
					kind: "extension_event",
					event: expect.objectContaining({ type: "process_created" }),
				}),
			]),
		);
	});

	it("reports internal start failures as post-commit server errors", async () => {
		const deps = createTestDeps();
		const launchPlan = { ...createLaunchPlan(), startTurnId: "run" };

		const result = await createProcessFromLaunchPlan(withStartFailure(deps), launchPlan);

		expect(result).toMatchObject({
			ok: false,
			stage: "post_commit",
			status: 500,
			body: expect.objectContaining({ code: "operation_failed" }),
		});
	});

	it("reports the committed process snapshot when start reactions fail", async () => {
		const deps = createTestDeps();
		const launchPlan = { ...createLaunchPlan(), startTurnId: "run" };

		const result = await createProcessFromLaunchPlan(
			{
				...deps,
				commands: {
					async startProcess(instanceId: string) {
						const process = deps.processes.update(instanceId, {
							selectedTurnId: "run",
							lifecycleStatus: "active",
						});
						if (!process) throw new Error("Expected launched process");
						return {
							ok: false as const,
							code: "worker_reconcile_failed",
							message: "Worker reconcile failed",
							stage: "post_commit" as const,
							process,
						};
					},
				} as never,
			},
			launchPlan,
		);

		expect(result).toMatchObject({
			ok: false,
			stage: "post_commit",
			process: {
				selectedTurnId: "run",
				lifecycleStatus: "active",
			},
		});
	});
});
