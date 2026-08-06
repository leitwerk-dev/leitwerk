import { rm } from "node:fs/promises";
import { trimString } from "@leitwerk-dev/domain";
import {
	formatLocalRepoChangeLaunchErrors,
	type LocalRepoChangeLaunchPlanner,
	localRepoChangeImportedPlanLauncherId,
} from "@leitwerk-dev/local-repo-change";
import {
	createEmptyStructuralProcessState,
	flow,
	humanTurn,
	revisionAction,
} from "@leitwerk-dev/process-sdk";
import { followupForm, handoffForm, processAnalysisActionIds } from "./actions.js";
import {
	type ProcessAnalysisParams,
	processAnalysisParamsCodec,
	validateProcessAnalysisLaunchInput,
} from "./params.js";
import {
	getProcessAnalysisRuntime,
	isProcessAnalysisRuntimeGitRepo,
	resolveProcessAnalysisRuntimeRepoConfig,
} from "./server-runtime.js";
import { downloadProcessSnapshot } from "./snapshot-downloader.js";
import { type ProcessAnalysisState, processAnalysisStateCodec } from "./state.js";

const turnIds = {
	downloadProcess: "download_process",
	analyzeProcess: "analyze_process",
	analysisDecision: "analysis_decision",
	handoff: "handoff_local_repo_change",
} as const;
const products = { analysis: "analysis" } as const;

function analysisPrompt(ctx: {
	params: ProcessAnalysisParams;
	state: ProcessAnalysisState;
}): string {
	const snapshot = ctx.state.snapshot;
	if (!snapshot) throw new Error("No process snapshot is available for analysis");
	return [
		"Analyze the referenced leitwerk process for the operator.",
		"You are in read-only analysis mode. Use only read and bash inspection commands. Do not modify files.",
		"Run from the server launch directory shown below. Code/repo inspection must happen only from that analysis directory. Limit process-specific evidence to the downloaded snapshot directory unless the operator asks for repository code inspection.",
		`Original instruction:\n${ctx.params.instruction}`,
		`Snapshot directory: ${snapshot.snapshotDir}\nAnalysis directory: ${ctx.params.analysisCwd}\nSource: ${snapshot.apiUrl}`,
		"Publish a concise analysis with: findings, evidence, likely root cause, and recommended next steps. If a repository change is needed, include implementation guidance suitable for handoff.",
	].join("\n\n");
}

async function runHandoff(
	launchPlanner: LocalRepoChangeLaunchPlanner,
	ctx: {
		process: { id: string };
		params: ProcessAnalysisParams;
		state: ProcessAnalysisState;
	},
	input: Record<string, unknown> = {},
) {
	const runtime = getProcessAnalysisRuntime();
	if (!runtime.processLaunches) throw new Error("process launch service is not configured");
	const snapshot = ctx.state.snapshot;
	if (!snapshot) throw new Error("No process snapshot is available for handoff");
	if (!(await isProcessAnalysisRuntimeGitRepo())) {
		throw new Error(
			`Cannot start Local Repo Change handoff: server launch directory is not a git repository (${runtime.analysisCwd})`,
		);
	}
	const runtimeRepo = await resolveProcessAnalysisRuntimeRepoConfig();
	const note = trimString(input.note);
	const analysis = trimString(input.analysisMarkdown);
	const prompt = [
		"Implement the fix identified by a process analysis handoff.",
		note ? `Operator handoff note:\n${note}` : null,
		`Original analysis instruction:\n${ctx.params.instruction}`,
	]
		.filter(Boolean)
		.join("\n\n");
	const importedPlanMarkdown = [
		"# Imported process-analysis plan",
		`- Source process: ${snapshot.sourceProcessId}`,
		`- Source URL: ${snapshot.apiUrl}`,
		`- Analysis process: ${ctx.process.id}`,
		`- Snapshot directory: ${snapshot.snapshotDir}`,
		"",
		"## Operator instruction",
		ctx.params.instruction,
		note ? `\n## Handoff note\n${note}` : "",
		"\n## Analysis",
		analysis || "No analysis markdown was available.",
	].join("\n");
	const metadata = {
		processAnalysisHandoff: {
			sourceAnalysisProcessId: ctx.process.id,
			sourceProcessId: snapshot.sourceProcessId,
			sourceProcessUrl: snapshot.apiUrl,
		},
	};
	const planned = launchPlanner.plan({
		input: {
			launchKind: "imported_plan",
			repoLocator: runtimeRepo.repoLocator,
			baseBranch: runtimeRepo.baseBranch,
			workBranch: "",
			prompt,
			importedPlanMarkdown,
		},
		metadata,
	});
	if (!planned.ok) {
		throw new Error(
			`Invalid local repo change handoff input: ${formatLocalRepoChangeLaunchErrors(planned.errors)}`,
		);
	}
	const handoffDedupKey = `process-analysis:${ctx.process.id}:local-repo-change`;
	const result = await runtime.processLaunches.createProcessFromLaunchConfig({
		launcherId: localRepoChangeImportedPlanLauncherId,
		launchConfig: planned.launchConfig,
		handoffDedupKey,
	});
	if (!result.ok) {
		throw new Error(`Failed to launch local repo change: ${JSON.stringify(result.body)}`);
	}
	return { linkedId: result.process.id, reused: result.reused };
}

const downloadTurn = flow
	.serverAutomatic<ProcessAnalysisParams, ProcessAnalysisState>(turnIds.downloadProcess)
	.description("Download process snapshot")
	.run(async (ctx) => {
		const snapshot = await downloadProcessSnapshot({
			analysisProcessId: ctx.process.id,
			processRef: ctx.params.processRef,
		});
		return {
			outcome: "downloaded",
			params: {},
			markdown: `Downloaded process snapshot to ${snapshot.snapshotDir}.`,
			state: { ...ctx.state, snapshot },
		};
	})
	.outcome("downloaded", (outcome) =>
		outcome.description("Snapshot downloaded").to(turnIds.analyzeProcess),
	);

const analyzeTurn = flow
	.llm<ProcessAnalysisParams, ProcessAnalysisState>(turnIds.analyzeProcess)
	.description("Analyze process")
	.tools("read", "bash")
	.freshPrimary()
	.buildPrompt(analysisPrompt)
	.publish(products.analysis)
	.to(turnIds.analysisDecision);

function buildDecisionTurn(handoffAvailable: boolean) {
	const reviseAnalysis = (label: string) =>
		revisionAction<ProcessAnalysisParams, ProcessAnalysisState>({
			label,
			acceptanceState: "neutral",
			form: followupForm,
			to: turnIds.analyzeProcess,
			queueTarget: { productName: products.analysis },
			schedulable: true,
		});
	return humanTurn<ProcessAnalysisParams, ProcessAnalysisState>({
		description: "Review process analysis",
		reviewProduct: products.analysis,
		commentary: handoffAvailable
			? "Ask follow-up questions, refresh the snapshot, or hand the analysis to a Local Repo Change process."
			: "Ask follow-up questions, refine the analysis, or refresh the snapshot.",
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
				to: turnIds.downloadProcess,
			},
			...(handoffAvailable
				? {
						[processAnalysisActionIds.startLocalRepoChange]: {
							label: "Start Local Repo Change",
							acceptanceState: "accepted" as const,
							form: handoffForm,
							to: turnIds.handoff,
							effect: ({ ctx, input }) => ({
								state: {
									...ctx.state,
									pendingHandoffInput: {
										...input,
										analysisMarkdown: ctx.readProductTurnResultMarkdown(products.analysis) ?? "",
									},
								},
							}),
						},
					}
				: {}),
		},
	});
}

function buildHandoffTurn(launchPlanner: LocalRepoChangeLaunchPlanner) {
	return flow
		.serverAutomatic<ProcessAnalysisParams, ProcessAnalysisState>(turnIds.handoff)
		.description("Start Local Repo Change handoff")
		.run(async (ctx) => {
			const result = await runHandoff(launchPlanner, ctx, ctx.state.pendingHandoffInput ?? {});
			return {
				outcome: "launched",
				params: { linkedProcessId: result.linkedId, reused: result.reused },
				markdown: `${result.reused ? "Reused" : "Created"} Local Repo Change process ${result.linkedId}.`,
				state: { ...ctx.state, pendingHandoffInput: null },
			};
		})
		.outcome("launched", (outcome) =>
			outcome
				.description("Local Repo Change process linked")
				.requiredString("linkedProcessId", "Linked process id")
				.boolean("reused", "Whether an existing handoff was reused")
				.complete(),
		);
}

export function createProcessAnalysisProcess(launchPlanner?: LocalRepoChangeLaunchPlanner) {
	let processBuilder = flow
		.process<ProcessAnalysisParams, ProcessAnalysisState>("process_analysis_process")
		.displayName("Process Analysis")
		.entry(turnIds.downloadProcess)
		.codecs({ params: processAnalysisParamsCodec, state: processAnalysisStateCodec })
		.piConfig({ sessionCwdTemplate: "{{{analysisCwd}}}" })
		.initialState(() => ({
			...createEmptyStructuralProcessState(),
			snapshot: null,
			pendingHandoffInput: null,
		}))
		.turn(downloadTurn)
		.turn(analyzeTurn)
		.turn({ id: turnIds.analysisDecision, definition: buildDecisionTurn(Boolean(launchPlanner)) });
	if (launchPlanner) {
		processBuilder = processBuilder.turn(buildHandoffTurn(launchPlanner));
	}
	return processBuilder
		.server((api) => {
			api.onCleanup(async (ctx) => {
				const snapshotDir = ctx.state.snapshot?.snapshotDir;
				if (!snapshotDir) return {};
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
								startTurnId: turnIds.downloadProcess,
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
