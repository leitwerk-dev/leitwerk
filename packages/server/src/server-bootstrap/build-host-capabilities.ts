import path from "node:path";
import {
	coreHostCapabilities,
	createCapabilityAccessor,
	type ExtensionProcessDefinition,
	type ExternalSourceServiceLike,
	type ProcessActionSummaryLike,
	type ProcessLaunchPlan,
	type ProcessLaunchPlanServiceLike,
	type ProcessModelSelectionServiceLike,
	type ProcessQuestionServiceLike,
	type ProvidedCapability,
} from "@leitwerk-dev/process-sdk";
import type { LeitwerkConfig } from "../config/index.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ExtensionHost } from "../extensions/extension-host.js";
import type { ProcessEngine, ProcessEngineLogger } from "../process-engine/types.js";
import {
	createProcessFromLaunchConfig,
	createProcessFromLaunchPlan,
	type ProcessLaunchExecutorDeps,
} from "../process-launch-executor.js";
import type { ProcessTitleGenerator } from "../process-title-generator.js";
import type { ProjectMutationService } from "../project-mutation-service.js";
import type { ResultImageStore } from "../result-image-store.js";
import type { WorkerSupervisor } from "../supervisor/worker-supervisor.js";
import type { Broadcaster } from "../ws/broadcast.js";

export function buildHostCapabilities(input: {
	config: LeitwerkConfig;
	baseDeps: RepositoryBundle & { broadcaster: Broadcaster };
	projectMutations: ProjectMutationService;
	commands: ProcessEngine;
	getSupervisor: () => WorkerSupervisor | undefined;
	listVisibleActionsForProcess: (instanceId: string) => readonly ProcessActionSummaryLike[];
	launcherService: unknown;
	launcherRecentValues: unknown;
	launcherModelConfigs: unknown;
	launchPlans: ProcessLaunchPlanServiceLike;
	processTitles?: ProcessTitleGenerator;
	extensionHost?: ExtensionHost;
	logger?: ProcessEngineLogger;
	processWatcherService: unknown;
	externalSourceService: ExternalSourceServiceLike;
	processModelSelection: ProcessModelSelectionServiceLike;
	resultImages: ResultImageStore;
	repositoryCredentials: import("../repository-credentials/service.js").RepositoryCredentialService;
	processDefinitions: ReadonlyMap<string, ExtensionProcessDefinition>;
	processQuestions: ProcessQuestionServiceLike;
	preProvidedCapabilities?: readonly ProvidedCapability[];
}) {
	const launchExecutorDeps = {
		commitMessages: input.config.commit_messages,
		processes: input.baseDeps.processes,
		projects: input.baseDeps.projects,
		skills: input.baseDeps.skills,
		processSkills: input.baseDeps.processSkills,
		handoffDedupKeys: input.baseDeps.handoffDedupKeys,
		futureExecutions: input.baseDeps.futureExecutions,
		transaction: input.baseDeps.transaction,
		broadcaster: input.baseDeps.broadcaster,
		commands: input.commands,
		processTitles: input.processTitles,
		extensionHost: input.extensionHost,
		logger: input.logger,
		processDefinitions: input.processDefinitions,
		repositoryCredentials: input.repositoryCredentials,
	} satisfies ProcessLaunchExecutorDeps;
	const hostCapabilities = createCapabilityAccessor([
		{
			token: coreHostCapabilities.serverSetup,
			value: {
				get serverBaseUrl() {
					return input.config.server.base_url;
				},
				get processWorkspacesDir() {
					return path.resolve(input.config.storage.process_workspaces_dir);
				},
				components: input.config.components,
				externalWrites: input.baseDeps.externalWrites,
				processes: input.baseDeps.processes,
				projects: input.projectMutations,
				events: input.baseDeps.events,
				broadcaster: input.baseDeps.broadcaster,
				commands: input.commands,
				processActions: {
					listVisibleActions(instanceId: string) {
						return input.listVisibleActionsForProcess(instanceId);
					},
					async executeAction(
						instanceId: string,
						actionId: string,
						inputValue: Record<string, unknown>,
						opts?: {
							source?: "ui" | "external" | "scheduled";
							origin?: "web_ui" | "external_interface" | "scheduled";
							nextTurnModelProfileId?: string | null;
							actor?: import("@leitwerk-dev/domain").Actor;
						},
					) {
						return input.commands.executeProcessAction(instanceId, actionId, inputValue, opts);
					},
				},
				externalSources: input.externalSourceService,
				getSupervisor: input.getSupervisor,
				launcherService: input.launcherService,
				launcherRecentValues: input.launcherRecentValues,
				launcherModelConfigs: input.launcherModelConfigs,
				launchPlans: input.launchPlans,
				processLaunches: {
					createProcessFromLaunchConfig(
						configInput: import("@leitwerk-dev/process-sdk").ProcessLaunchConfigExecutionInput,
						opts?: { actor?: import("@leitwerk-dev/domain").Actor },
					) {
						return createProcessFromLaunchConfig(launchExecutorDeps, configInput, opts);
					},
					createProcessFromLaunchPlan(
						launchPlan: ProcessLaunchPlan,
						opts?: { actor?: import("@leitwerk-dev/domain").Actor },
					) {
						return createProcessFromLaunchPlan(launchExecutorDeps, launchPlan, opts);
					},
				},
				handoffDedupKeys: input.baseDeps.handoffDedupKeys,
				processWatchers: input.processWatcherService,
				processModelSelection: input.processModelSelection,
				processQuestions: input.processQuestions,
				repositoryCredentials: input.repositoryCredentials,
				resultImages: {
					async get(instanceId: string, turnRecordId: string, imageId: string) {
						return (await input.resultImages.get(instanceId, turnRecordId, imageId))?.bytes ?? null;
					},
				},
			},
		},
		{
			token: coreHostCapabilities.processModelSelection,
			value: input.processModelSelection,
		},
	]);

	for (const cap of input.preProvidedCapabilities ?? []) {
		hostCapabilities.provide(cap.token, cap.value);
	}

	return hostCapabilities;
}
