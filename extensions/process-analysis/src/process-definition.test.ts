import {
	buildProcessLaunchersForTest,
	buildServerProcessForTest,
	createTestProcessInstance,
	createTestWorkerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { getProcessGraph, resolveHumanTurnView } from "@leitwerk-dev/process-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { processAnalysisActionIds } from "./actions.js";
import { processAnalysisProcess, processAnalysisTurnIds } from "./process-definition.js";
import { configureProcessAnalysisRuntime } from "./server-runtime.js";
import { processAnalysisDownloadSnapshotTool } from "./tools.js";

const testParams = {
	processRef: "agt_source",
	instruction: "Find the problem",
	analysisCwd: "/tmp/test-runtime-cwd",
};

function createSnapshot() {
	return {
		sourceProcessId: "agt_source",
		apiUrl: "http://localhost/api/processes/agt_source",
		snapshotDir: "/tmp/snapshot",
		downloadedAt: "2026-01-01T00:00:00.000Z",
	};
}

function getUiLauncher() {
	const launcher = buildProcessLaunchersForTest(processAnalysisProcess)?.launchers.get(
		"process_analysis_process.ui_launcher",
	)?.ui;
	if (!launcher) throw new Error("Expected Process Analysis UI launcher");
	return launcher;
}

function getTurnTransitions(turnId: string) {
	return getProcessGraph(
		new Map([[processAnalysisProcess.id, processAnalysisProcess]]),
		processAnalysisProcess.id,
	).turns.get(turnId)?.transitions;
}

describe("processAnalysisProcess", () => {
	beforeEach(() => {
		configureProcessAnalysisRuntime({ analysisCwd: "/tmp/process-analysis-runtime-cwd" });
	});

	it("launches with runtime cwd as a hidden param", () => {
		const launcher = getUiLauncher();
		expect(
			launcher.launchConfigSchema.fields.find((field) => field.id === "processRef"),
		).toMatchObject({
			rememberRecentValues: true,
		});

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
				startTurnId: processAnalysisTurnIds.analyzeProcess,
				titleSourceFields: [{ label: "Analysis instruction", value: "Find the problem" }],
			},
		});
		expect("projects" in (result.ok ? result.launchConfig : {})).toBe(false);
		expect(processAnalysisProcess.piConfig?.sessionCwdTemplate).toBe("{{{analysisCwd}}}");
	});

	it("returns required errors for blank visible launch fields", () => {
		expect(getUiLauncher().resolveLaunchConfig({ processRef: " ", instruction: "" })).toEqual({
			ok: false,
			errors: [
				{ code: "required", fieldId: "processRef", message: "processRef is required" },
				{ code: "required", fieldId: "instruction", message: "instruction is required" },
			],
		});
	});

	it("defines only analysis and decision turns", () => {
		expect([...processAnalysisProcess.turns.keys()]).toEqual([
			processAnalysisTurnIds.analyzeProcess,
			processAnalysisTurnIds.analysisDecision,
		]);
		expect(
			buildServerProcessForTest(processAnalysisProcess)?.actions.has("start_local_repo_change"),
		).toBe(false);
	});

	it("lets the operator complete analysis", () => {
		const turn = processAnalysisProcess.turns.get(
			processAnalysisTurnIds.analysisDecision,
		)?.definition;
		expect(turn?.kind).toBe("human");
		if (turn?.kind !== "human") return;
		expect(
			resolveHumanTurnView({ turnId: processAnalysisTurnIds.analysisDecision, turn }).actions.find(
				(action) => action.actionId === processAnalysisActionIds.completeAnalysis,
			),
		).toMatchObject({ label: "Complete analysis" });
		expect(getTurnTransitions(processAnalysisTurnIds.analysisDecision)).toContainEqual({
			trigger: processAnalysisActionIds.completeAnalysis,
			lifecycleStatus: "completed",
		});
		expect(getTurnTransitions(processAnalysisTurnIds.analysisDecision)).toContainEqual({
			trigger: processAnalysisActionIds.refreshSnapshot,
			nextTurnId: processAnalysisTurnIds.analyzeProcess,
		});
	});

	it("prepares the analysis through the authorized integration tool", async () => {
		const turn = processAnalysisProcess.turns.get(
			processAnalysisTurnIds.analyzeProcess,
		)?.definition;
		if (turn?.kind !== "llm" || !turn.prepare) throw new Error("Expected prepared LLM turn");
		expect(turn.integrationTools).toEqual([processAnalysisDownloadSnapshotTool]);
		const snapshot = createSnapshot();
		const callIntegrationTool = vi.fn(async () => snapshot);
		const reportProgress = vi.fn();
		const ctx = {
			...createTestWorkerProcessContext({
				process: createTestProcessInstance({ processId: processAnalysisProcess.id }),
				params: testParams,
				state: processAnalysisProcess.initialState(testParams),
			}),
			callIntegrationTool,
			reportProgress,
		};
		const prepared = await turn.prepare(ctx);
		expect(callIntegrationTool).toHaveBeenCalledWith(processAnalysisDownloadSnapshotTool, {
			processRef: "agt_source",
		});
		expect(prepared).toEqual(snapshot);
		expect(reportProgress).toHaveBeenLastCalledWith({
			title: "Analysis preparation",
			steps: [{ id: "download_snapshot", label: "Download process snapshot", status: "completed" }],
		});
		expect(await turn.prompt({ ...ctx, prepared })).toContain("Snapshot directory: /tmp/snapshot");
	});
});
