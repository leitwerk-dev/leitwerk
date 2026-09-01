import { rm } from "node:fs/promises";
import {
	createEmptyStructuralProcessState,
	flow,
	humanTurn,
	revisionAction,
} from "@leitwerk-dev/process-sdk";
import { followupForm, processAnalysisActionIds } from "./actions.js";
import {
	type ProcessAnalysisParams,
	processAnalysisParamsCodec,
	validateProcessAnalysisLaunchInput,
} from "./params.js";
import { getProcessAnalysisRuntime } from "./server-runtime.js";
import { resolveProcessSnapshotDirectory } from "./snapshot-downloader.js";
import {
	type ProcessAnalysisState,
	parseProcessAnalysisSnapshotState,
	processAnalysisStateCodec,
} from "./state.js";
import { processAnalysisDownloadSnapshotTool } from "./tools.js";

const turnIds = {
	analyzeProcess: "analyze_process",
	analysisDecision: "analysis_decision",
} as const;
const products = { analysis: "analysis" } as const;

function analysisPrompt(ctx: {
	params: ProcessAnalysisParams;
	prepared: NonNullable<ProcessAnalysisState["snapshot"]>;
}): string {
	const snapshot = ctx.prepared;
	return [
		"Analyze the referenced leitwerk process for the operator.",
		"You are in read-only analysis mode. Use only read and bash inspection commands. Do not modify files.",
		"Run from the server launch directory shown below. Code/repo inspection must happen only from that analysis directory. Limit process-specific evidence to the downloaded snapshot directory unless the operator asks for repository code inspection.",
		`Original instruction:\n${ctx.params.instruction}`,
		`Snapshot directory: ${snapshot.snapshotDir}\nAnalysis directory: ${ctx.params.analysisCwd}\nSource: ${snapshot.apiUrl}`,
		"Publish a concise analysis with: findings, evidence, likely root cause, and recommended next steps. If a repository change is needed, include implementation guidance suitable for handoff.",
	].join("\n\n");
}

const analyzeTurn = flow
	.llm<ProcessAnalysisParams, ProcessAnalysisState>(turnIds.analyzeProcess)
	.description("Analyze process")
	.integrationTools(processAnalysisDownloadSnapshotTool)
	.prepare(async (ctx) => {
		ctx.reportProgress({
			title: "Analysis preparation",
			steps: [
				{ id: "download_snapshot", label: "Download process snapshot", status: "in_progress" },
			],
		});
		const result = await ctx.callIntegrationTool(processAnalysisDownloadSnapshotTool, {
			processRef: ctx.params.processRef,
		});
		const snapshot = parseProcessAnalysisSnapshotState(result);
		if (!snapshot) throw new Error("Snapshot tool returned an invalid process snapshot");
		ctx.reportProgress({
			title: "Analysis preparation",
			steps: [{ id: "download_snapshot", label: "Download process snapshot", status: "completed" }],
		});
		return snapshot;
	})
	.tools("read", "bash")
	.freshPrimary()
	.buildPrompt(analysisPrompt)
	.publish(products.analysis)
	.to(turnIds.analysisDecision);

const reviseAnalysis = (label: string) =>
	revisionAction<ProcessAnalysisParams, ProcessAnalysisState>({
		label,
		acceptanceState: "neutral",
		form: followupForm,
		to: turnIds.analyzeProcess,
		queueTarget: { productName: products.analysis },
		schedulable: true,
	});

const decisionTurn = humanTurn<ProcessAnalysisParams, ProcessAnalysisState>({
	description: "Review process analysis",
	reviewProduct: products.analysis,
	commentary: "Ask follow-up questions, refine the analysis, or refresh the snapshot.",
	actions: {
		[processAnalysisActionIds.completeAnalysis]: {
			label: "Complete analysis",
			acceptanceState: "accepted",
			complete: true,
		},
		[processAnalysisActionIds.askFollowup]: reviseAnalysis("Ask follow-up"),
		[processAnalysisActionIds.refineAnalysis]: reviseAnalysis("Refine analysis"),
		[processAnalysisActionIds.refreshSnapshot]: {
			label: "Refresh snapshot",
			acceptanceState: "neutral",
			to: turnIds.analyzeProcess,
		},
	},
});

export function createProcessAnalysisProcess() {
	return flow
		.process<ProcessAnalysisParams, ProcessAnalysisState>("process_analysis_process")
		.displayName("Process Analysis")
		.entry(turnIds.analyzeProcess)
		.codecs({ params: processAnalysisParamsCodec, state: processAnalysisStateCodec })
		.piConfig({ sessionCwdTemplate: "{{{analysisCwd}}}" })
		.initialState(() => ({
			...createEmptyStructuralProcessState(),
			snapshot: null,
		}))
		.turn(analyzeTurn)
		.turn({ id: turnIds.analysisDecision, definition: decisionTurn })
		.server((api) => {
			api.onCleanup(async (ctx) => {
				let snapshotDir = ctx.state.snapshot?.snapshotDir ?? null;
				if (!snapshotDir) {
					try {
						snapshotDir = resolveProcessSnapshotDirectory({
							analysisProcessId: ctx.process.id,
							processRef: ctx.params.processRef,
						}).baseDir;
					} catch {
						return { state: { ...ctx.state, snapshot: null } };
					}
				}
				await rm(snapshotDir, { recursive: true, force: true });
				return { state: { ...ctx.state, snapshot: null } };
			});
		})
		.launcher((api) => {
			api.launcher({
				id: "process_analysis_process.ui_launcher",
				label: "Process Analysis",
				description: "Download an leitwerk process snapshot and analyze it read-only.",
				visibility: "ui",
				ui: {
					card: { title: "Process Analysis", description: "Analyze another process by id or URL." },
					launchConfigSchema: {
						id: "process_analysis_form",
						title: "Process Analysis",
						fields: [
							{
								id: "processRef",
								label: "Process id or URL",
								kind: "text",
								required: true,
								rememberRecentValues: true,
							},
							{ id: "instruction", label: "What to analyze", kind: "textarea", required: true },
						],
						submitLabel: "Start analysis",
					},
					resolveDefaults() {
						return { processRef: "", instruction: "" };
					},
					resolveLaunchConfig(input) {
						const validated = validateProcessAnalysisLaunchInput(input);
						if (!validated.ok) return { ok: false, errors: validated.errors };
						const runtime = getProcessAnalysisRuntime();
						return {
							ok: true,
							launchConfig: {
								processId: "process_analysis_process",
								params: { ...validated.value, analysisCwd: runtime.analysisCwd },
								startTurnId: turnIds.analyzeProcess,
								titleSourceFields: [
									{ label: "Analysis instruction", value: validated.value.instruction },
								],
							},
						};
					},
				},
			});
		})
		.define();
}

export const processAnalysisProcess = createProcessAnalysisProcess();

export const processAnalysisTurnIds = turnIds;
