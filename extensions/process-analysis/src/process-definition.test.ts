import {
	buildExtensionCatalogFromModules,
	buildProcessLaunchersForTest,
	buildServerProcessForTest,
	createTestProcessInstance,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import localRepoChangeExtension, {
	localRepoChangeLaunchPlanner,
} from "@leitwerk-dev/local-repo-change";
import { getProcessGraph, resolveHumanTurnView } from "@leitwerk-dev/process-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processAnalysisActionIds } from "./actions.js";
import processAnalysisExtension from "./index.js";
import {
	createProcessAnalysisProcess,
	processAnalysisProcess,
	processAnalysisTurnIds,
} from "./process-definition.js";
import {
	configureProcessAnalysisRuntime,
	isProcessAnalysisRuntimeGitRepo,
	resolveProcessAnalysisRuntimeRepoConfig,
} from "./server-runtime.js";
import type { ProcessAnalysisState } from "./state.js";

const processAnalysisWithHandoff = createProcessAnalysisProcess(localRepoChangeLaunchPlanner);
const testParams = {
	processRef: "agt_source",
	instruction: "Find the problem",
	analysisCwd: "/tmp/test-runtime-cwd",
};

function createState(overrides: Partial<ProcessAnalysisState> = {}): ProcessAnalysisState {
	return { ...processAnalysisProcess.initialState(testParams), ...overrides };
}

function createSnapshot() {
	return {
		sourceProcessId: "agt_source",
		apiUrl: "http://localhost/api/processes/agt_source",
		snapshotDir: "/tmp/snapshot",
		downloadedAt: "2026-01-01T00:00:00.000Z",
	};
}

function getHandoffTurn() {
	const turn = processAnalysisWithHandoff.turns.get(processAnalysisTurnIds.handoff)?.definition;
	if (turn?.kind !== "server_automatic") throw new Error("Expected server-automatic handoff turn");
	return turn;
}

function getUiLauncher() {
	const launcher = buildProcessLaunchersForTest(processAnalysisProcess)?.launchers.get(
		"process_analysis_process.ui_launcher",
	)?.ui;
	if (!launcher) throw new Error("Expected Process Analysis UI launcher");
	return launcher;
}

function getTurnTransitions(process: typeof processAnalysisProcess, turnId: string) {
	return getProcessGraph(new Map([[process.id, process]]), process.id).turns.get(turnId)
		?.transitions;
}

describe("processAnalysisProcess", () => {
	beforeEach(() => {
		configureProcessAnalysisRuntime({ analysisCwd: "/tmp/process-analysis-runtime-cwd" });
	});

	it("launches with runtime cwd as a hidden param", () => {
		const launcher = getUiLauncher();
		expect(
			launcher.launchConfigSchema.fields.find((field) => field.id === "processRef"),
		).toMatchObject({ rememberRecentValues: true });

		const result = launcher.resolveLaunchConfig({
			processRef: "https://ignored.example/processes/agt_source",
			instruction: "Find the problem",
		});

		expect(result).toEqual({
			ok: true,
			launchConfig: {
				processId: "process_analysis_process",
				params: {
					processRef: "https://ignored.example/processes/agt_source",
					instruction: "Find the problem",
					analysisCwd: "/tmp/process-analysis-runtime-cwd",
				},
				startTurnId: processAnalysisTurnIds.downloadProcess,
				titleSourceFields: [{ label: "Analysis instruction", value: "Find the problem" }],
			},
		});
		expect("projects" in (result.ok ? result.launchConfig : {})).toBe(false);
		expect(processAnalysisProcess.piConfig?.sessionCwdTemplate).toBe("{{{analysisCwd}}}");
	});

	it("returns required errors for blank visible launch fields", () => {
		const result = getUiLauncher().resolveLaunchConfig({ processRef: " ", instruction: "" });

		expect(result).toEqual({
			ok: false,
			errors: [
				{ code: "required", fieldId: "processRef", message: "processRef is required" },
				{ code: "required", fieldId: "instruction", message: "instruction is required" },
			],
		});
	});

	it("lets the operator complete analysis without starting a handoff", () => {
		const turn = processAnalysisProcess.turns.get(
			processAnalysisTurnIds.analysisDecision,
		)?.definition;
		expect(turn?.kind).toBe("human");
		if (turn?.kind !== "human") return;

		expect(
			resolveHumanTurnView({
				turnId: processAnalysisTurnIds.analysisDecision,
				turn,
			}).actions.find((action) => action.actionId === processAnalysisActionIds.completeAnalysis),
		).toMatchObject({ label: "Complete analysis" });
		expect(
			getTurnTransitions(processAnalysisProcess, processAnalysisTurnIds.analysisDecision),
		).toContainEqual({
			trigger: processAnalysisActionIds.completeAnalysis,
			lifecycleStatus: "completed",
		});
	});

	it("stores handoff form input and analysis markdown before handoff turn", async () => {
		const definition = buildServerProcessForTest(processAnalysisWithHandoff);
		const action = definition?.actions.get(processAnalysisActionIds.startLocalRepoChange);
		expect(action).toBeDefined();
		if (!action?.plan) return;

		const transitions: Array<Record<string, unknown>> = [];
		const state = createState();
		await action.plan(
			{ note: "Fix it" },
			createTestServerProcessContext({
				process: createTestProcessInstance({
					processId: processAnalysisWithHandoff.id,
					selectedTurnId: processAnalysisTurnIds.analysisDecision,
					lifecycleStatus: "waiting",
				}),
				params: testParams,
				state,
				transition: async (next) => {
					transitions.push(next as Record<string, unknown>);
				},
				readProductTurnResultMarkdown: (productName) =>
					productName === "analysis" ? "## Analysis\n\nUse better error handling." : null,
			}),
		);

		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({
			turnId: processAnalysisTurnIds.handoff,
			trigger: processAnalysisActionIds.startLocalRepoChange,
			state: {
				...state,
				pendingHandoffInput: {
					note: "Fix it",
					analysisMarkdown: "## Analysis\n\nUse better error handling.",
				},
			},
		});
	});

	it("completes after a Local Repo Change is successfully launched or reused", () => {
		expect(
			getTurnTransitions(processAnalysisWithHandoff, processAnalysisTurnIds.handoff),
		).toContainEqual({ outcome: "launched", lifecycleStatus: "completed" });
	});

	it("omits the handoff action and turn when the planner capability is unavailable", () => {
		const definition = buildServerProcessForTest(processAnalysisProcess);
		expect(definition?.actions.has(processAnalysisActionIds.startLocalRepoChange)).toBe(false);
		expect(processAnalysisProcess.turns.has(processAnalysisTurnIds.handoff)).toBe(false);
	});

	it("acquires the optional planner capability when both extensions are loaded", async () => {
		const catalog = await buildExtensionCatalogFromModules([
			processAnalysisExtension,
			localRepoChangeExtension,
		]);
		const process = catalog.processes.get("process_analysis_process");
		expect(process?.turns.has(processAnalysisTurnIds.handoff)).toBe(true);
		expect(
			buildServerProcessForTest(process)?.actions.has(
				processAnalysisActionIds.startLocalRepoChange,
			),
		).toBe(true);
	});
});

describe("isProcessAnalysisRuntimeGitRepo", () => {
	it("returns true when analysisCwd is inside a git worktree", async () => {
		configureProcessAnalysisRuntime({ analysisCwd: process.cwd() });
		await expect(isProcessAnalysisRuntimeGitRepo()).resolves.toBe(true);
	});

	it("returns false when analysisCwd is not a git repository", async () => {
		configureProcessAnalysisRuntime({ analysisCwd: "/tmp/process-analysis-test-no-git" });
		await expect(isProcessAnalysisRuntimeGitRepo()).resolves.toBe(false);
	});
});

describe("resolveProcessAnalysisRuntimeRepoConfig", () => {
	it("resolves repo config from a git repository", async () => {
		configureProcessAnalysisRuntime({ analysisCwd: process.cwd() });
		const config = await resolveProcessAnalysisRuntimeRepoConfig();
		expect(config.repoLocator).toBe(process.cwd());
		expect(typeof config.baseBranch).toBe("string");
		expect(config.baseBranch.length).toBeGreaterThan(0);
	});

	it("falls back to main when origin HEAD is not available", async () => {
		// Use a non-existent directory that would fail all git commands
		configureProcessAnalysisRuntime({ analysisCwd: "/tmp/process-analysis-test-no-origin" });
		const config = await resolveProcessAnalysisRuntimeRepoConfig();
		expect(config.repoLocator).toBe("/tmp/process-analysis-test-no-origin");
		expect(config.baseBranch).toBe("main");
	});
});

describe("handoff turn with non-git analysisCwd", () => {
	it("throws when the server launch directory is not a git repository", async () => {
		configureProcessAnalysisRuntime({
			analysisCwd: "/tmp/process-analysis-test-no-git",
			// Provide a stub so the handoff passes the processLaunches != null guard
			// and reaches the git-repo check.
			processLaunches: {
				createProcessFromLaunchConfig: async () => ({
					ok: false as const,
					stage: "pre_commit" as const,
					status: 500,
					body: {},
				}),
				createProcessFromLaunchPlan: async () => ({
					ok: false as const,
					stage: "pre_commit" as const,
					status: 500,
					body: {},
				}),
			},
		});

		const handoffTurn = getHandoffTurn();
		const state = createState({ snapshot: createSnapshot(), pendingHandoffInput: {} });
		const ctx = createTestServerProcessContext({
			process: createTestProcessInstance({
				processId: processAnalysisWithHandoff.id,
				selectedTurnId: processAnalysisTurnIds.handoff,
				lifecycleStatus: "running",
			}),
			params: testParams,
			state,
		});

		await expect(handoffTurn.run(ctx)).rejects.toThrow(
			/Cannot start Local Repo Change handoff: server launch directory is not a git repository/,
		);
	});
});

describe("handoff turn with planner capability", () => {
	it("executes canonical imported-plan config with source-owned attribution and dedupe", async () => {
		const createProcessFromLaunchConfig = vi.fn(async () => ({
			ok: true as const,
			process: createTestProcessInstance({ id: "agt_local_change" }),
			projects: [],
			reused: false,
		}));
		configureProcessAnalysisRuntime({
			analysisCwd: process.cwd(),
			processLaunches: {
				createProcessFromLaunchConfig,
				createProcessFromLaunchPlan: async () => {
					throw new Error("unexpected plan execution");
				},
			},
		});
		const handoffTurn = getHandoffTurn();
		const state = createState({
			snapshot: createSnapshot(),
			pendingHandoffInput: {
				note: "Apply the fix",
				analysisMarkdown: "## Analysis\n\nUse canonical planning.",
			},
		});

		await handoffTurn.run(
			createTestServerProcessContext({
				process: createTestProcessInstance({
					id: "agt_analysis",
					processId: processAnalysisWithHandoff.id,
					selectedTurnId: processAnalysisTurnIds.handoff,
					lifecycleStatus: "active",
				}),
				params: { ...testParams, analysisCwd: process.cwd() },
				state,
			}),
		);

		expect(createProcessFromLaunchConfig).toHaveBeenCalledWith({
			launcherId: "local_repo_change_process.imported_plan",
			handoffDedupKey: "process-analysis:agt_analysis:local-repo-change",
			launchConfig: expect.objectContaining({
				processId: "local_repo_change_process",
				startTurnId: null,
				params: expect.objectContaining({
					launchKind: "imported_plan",
					importedPlanMarkdown: expect.stringContaining("Use canonical planning."),
				}),
				metadata: {
					processAnalysisHandoff: {
						sourceAnalysisProcessId: "agt_analysis",
						sourceProcessId: "agt_source",
						sourceProcessUrl: "http://localhost/api/processes/agt_source",
					},
				},
			}),
		});
	});
});
