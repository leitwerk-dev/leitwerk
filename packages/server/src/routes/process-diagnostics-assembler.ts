import { findUiLauncherById } from "@leitwerk-dev/process-sdk";
import {
	PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES,
	parseLauncherInputJson,
	parseLauncherTurnConfigsJson,
} from "@leitwerk-dev/protocol";
import type {
	LauncherModelConfigDefaults,
	ProcessDiagnosticsData,
	ProcessRetryConfig,
} from "@leitwerk-dev/protocol/http-contracts";
import { buildProcessFlowViewForProcess, serializeProcessGraph } from "../process-graph.js";
import { presentProcessModelConfiguration } from "../process-model-policy-presenter.js";
import { getProcessDisplayName } from "../process-operator-attention.js";
import {
	buildProcessLaunchConfigurationView,
	buildProcessRunDetailsView,
	getScheduledActionDetailForProcess,
	getSelectedTurnSummaryForProcess,
	listVisibleActionsForProcess,
	mergeProcessEventWindowsAscending,
	processDefinesLeafOutcome,
	type RouteDeps,
} from "./process-route-helpers.js";

export class ProcessDiagnosticsAssembler {
	constructor(private readonly deps: RouteDeps) {}

	async assembleDetail(instanceId: string): Promise<ProcessDiagnosticsData | null> {
		const process = this.deps.processes.getById(instanceId);
		if (!process) {
			return null;
		}
		const projects = this.deps.projects.listByInstance(instanceId);
		const piSessionTree = await this.deps.sessionReader.readPiSessionTree(instanceId);
		const recentEvents = this.deps.events.listByInstance(instanceId, 500);
		const retainedOperationalEvents = this.deps.events.listByInstanceEventTypes(
			instanceId,
			PRIMARY_PATH_OPERATIONAL_PI_EVENT_TYPES,
			1_000,
		);
		const events = mergeProcessEventWindowsAscending([recentEvents, retainedOperationalEvents]);
		const modelConfiguration = presentProcessModelConfiguration(
			this.deps.processModelPolicy.project({
				kind: "process_configuration",
				process,
				availability: this.deps.modelStatusCache.snapshot(),
			}),
		);
		return {
			process,
			projects,
			inputs: this.deps.inputs.listByInstance(instanceId),
			events,
			leafOutcomeSnapshots: this.deps.leafOutcomeSnapshots.listByInstance(instanceId),
			turnRecords: this.deps.turnRecords.listByInstance(instanceId),
			turnAnnotations: this.deps.turnAnnotations.listByInstance(instanceId),
			workerLease: this.deps.leases.getByInstance(instanceId),
			processDisplayName: getProcessDisplayName(this.deps, process.processId),
			processGraph: serializeProcessGraph(this.deps.processGraphs, process.processId),
			processFlow: buildProcessFlowViewForProcess(this.deps.processGraphs, process.processId),
			piSessionEntries: piSessionTree.entries,
			definesLeafOutcome: processDefinesLeafOutcome(this.deps, process),
			selectedTurn: getSelectedTurnSummaryForProcess(this.deps, process),
			scheduledAction: getScheduledActionDetailForProcess(this.deps, process),
			modelConfiguration,
			runDetails: buildProcessRunDetailsView(this.deps, process, projects),
			launchConfiguration: buildProcessLaunchConfigurationView(this.deps, process, projects),
			actions: listVisibleActionsForProcess(this.deps, process),
			toolRenderers: [...(this.deps.toolRenderers?.values() ?? [])],
		};
	}

	async assembleRetryConfig(instanceId: string): Promise<ProcessRetryConfig | null> {
		const process = this.deps.processes.getById(instanceId);
		if (!process) {
			return null;
		}
		const launchIntent = this.deps.processes.getLaunchIntent(instanceId);
		const preferredLauncherId =
			launchIntent?.launcherId ??
			(typeof process.metadata?.launcherId === "string" ? process.metadata.launcherId : null);
		const launcher =
			(preferredLauncherId
				? findUiLauncherById(this.deps.launcherService, preferredLauncherId)
				: null) ??
			this.deps.launcherService
				.listUiLaunchers()
				.find((candidate) => candidate.processId === process.processId);
		if (!launcher) {
			return null;
		}

		const parsedLauncherInput = parseLauncherInputJson(process.paramsJson, "paramsJson");
		const persistedLauncherInput =
			launchIntent?.launcherInput ?? (parsedLauncherInput.ok ? parsedLauncherInput.value : {});
		const launcherInput = await this.deps.launcherService.resolveUiRelaunchInput(
			launcher.id,
			persistedLauncherInput,
			{ process, projects: this.deps.projects.listByInstance(instanceId) },
		);
		const skillIds = this.deps.processSkills
			.listSelections(instanceId)
			.map(({ skillId }) => skillId);
		const modelConfig: LauncherModelConfigDefaults = {};
		if (process.defaultModelProfileId) {
			modelConfig.defaultModelProfileId = process.defaultModelProfileId;
		}
		if (process.turnConfigsJson) {
			const parsedTurnConfigs = parseLauncherTurnConfigsJson(process.turnConfigsJson);
			if (parsedTurnConfigs.ok) {
				modelConfig.turnConfigs = parsedTurnConfigs.value;
			}
		}
		return {
			launcherId: launcher.id,
			title: process.title ?? null,
			launcherInput,
			skillIds,
			modelConfig,
		};
	}
}
