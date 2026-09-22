import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { beforeEach, describe, expect, it, onTestFinished } from "vitest";
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

async function harness() {
	const test = await createExtensionTestHarness({
		extensions: [
			{
				manifest: { id: "analysis-test-tools", version: "1" },
				setupServer(api) {
					api.tool({
						name: processAnalysisDownloadSnapshotTool,
						description: "Download snapshot",
						parameters: {},
						execute: async () => createSnapshot(),
					});
				},
			},
		],
	});
	onTestFinished(() => test.close());
	return test.process(processAnalysisProcess, { params: testParams });
}

describe("processAnalysisProcess", () => {
	beforeEach(() => {
		configureProcessAnalysisRuntime({ analysisCwd: "/tmp/process-analysis-runtime-cwd" });
	});

	it("launches with runtime cwd as a hidden param", async () => {
		const process = await harness();
		const launcher = process.describe().launchers[0];
		if (!launcher) throw new Error("Missing launcher");
		expect(
			launcher.launchConfigSchema.fields.find((field) => field.id === "processRef"),
		).toMatchObject({
			rememberRecentValues: true,
		});

		const result = await process.resolveLaunch("process_analysis_process.ui_launcher", {
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

	it("returns required errors for blank visible launch fields", async () => {
		const process = await harness();
		expect(
			await process.resolveLaunch("process_analysis_process.ui_launcher", {
				processRef: " ",
				instruction: "",
			}),
		).toEqual({
			ok: false,
			errors: [
				{ code: "required", fieldId: "processRef", message: "processRef is required" },
				{ code: "required", fieldId: "instruction", message: "instruction is required" },
			],
		});
	});

	it("describes analysis turns and evaluates operator completion", async () => {
		const process = await harness();
		const description = process.describe();
		expect(description.turns.map((turn) => turn.id)).toEqual([
			processAnalysisTurnIds.analyzeProcess,
			processAnalysisTurnIds.analysisDecision,
		]);
		expect(description.actions.some((action) => action.id === "start_local_repo_change")).toBe(
			false,
		);
		expect(
			description.actions.find((action) => action.id === processAnalysisActionIds.completeAnalysis),
		).toMatchObject({ label: "Complete analysis" });
		const effects = await process.evaluateAction(
			processAnalysisActionIds.completeAnalysis,
			{},
			{
				position: {
					selectedTurnId: processAnalysisTurnIds.analysisDecision,
					lifecycleStatus: "waiting",
				},
			},
		);
		expect(effects.transitions).toContainEqual(
			expect.objectContaining({ lifecycleStatus: "completed" }),
		);
		expect(description.transitions).toContainEqual({
			from: processAnalysisTurnIds.analysisDecision,
			trigger: processAnalysisActionIds.refreshSnapshot,
			nextTurnId: processAnalysisTurnIds.analyzeProcess,
		});
	});

	it("prepares the analysis through the authorized integration tool", async () => {
		const process = await harness();
		const result = await process.evaluateTurn(processAnalysisTurnIds.analyzeProcess, {
			responses: [{ outcome: "analysis", markdown: "Analysis" }],
		});
		expect(result.tools).toEqual([
			{ name: processAnalysisDownloadSnapshotTool, arguments: { processRef: "agt_source" } },
		]);
		expect(result.progress.at(-1)).toEqual({
			title: "Analysis preparation",
			steps: [{ id: "download_snapshot", label: "Download process snapshot", status: "completed" }],
		});
		expect(result.prompts[0]).toContain("Snapshot directory: /tmp/snapshot");
	});
});
