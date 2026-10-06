import path from "node:path";
import { type Actor, SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import {
	coreHostCapabilities,
	createCapabilityAccessor,
	type ExternalSourceServiceLike,
	type PollingServiceLike,
	type ProcessActionServiceLike,
	type ProcessActionSummaryLike,
	type ProcessLaunchPlanServiceLike,
	type ProcessModelSelectionServiceLike,
	type ProcessQuestionServiceLike,
	type ProgrammaticLaunchRequestLike,
	type ProvidedCapability,
	type RegisteredProcessWatcherLike,
} from "@leitwerk-dev/process-sdk";
import { createWikiIntegration, topicWikiCapability } from "@leitwerk-dev/wiki/integration";
import type { LeitwerkConfig } from "../config/index.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { IntegrationToolRegistry } from "../integration-tool-registry.js";
import type { LaunchCoordinator } from "../launch-coordinator.js";
import type { ProcessEngine } from "../process-engine/types.js";
import type { ProjectMutationService } from "../project-mutation-service.js";
import type { ResultImageStore } from "../result-image-store.js";
import type { WorkerSupervisor } from "../supervisor/worker-supervisor.js";
import type { Broadcaster } from "../ws/broadcast.js";

export function buildHostCapabilities(input: {
	config: LeitwerkConfig;
	baseDeps: RepositoryBundle & { broadcaster: Broadcaster };
	projectMutations: ProjectMutationService;
	commands: ProcessEngine;
	integrationTools: IntegrationToolRegistry;
	getSupervisor: () => WorkerSupervisor | undefined;
	listVisibleActionsForProcess: (instanceId: string) => readonly ProcessActionSummaryLike[];
	launcherService: unknown;
	launcherRecentValues: unknown;
	launcherModelConfigs: unknown;
	launchPlans: ProcessLaunchPlanServiceLike;
	processWatcherService: unknown;
	polling: PollingServiceLike;
	externalSourceService: ExternalSourceServiceLike;
	processModelSelection: ProcessModelSelectionServiceLike;
	resultImages: ResultImageStore;
	repositoryCredentials: import("../repository-credentials/service.js").RepositoryCredentialService;
	processQuestions: ProcessQuestionServiceLike;
	launchCoordinator: LaunchCoordinator;
	preProvidedCapabilities?: readonly ProvidedCapability[];
}) {
	const hostCapabilities = createCapabilityAccessor([
		{ token: topicWikiCapability, value: createWikiIntegration(input.baseDeps.topicWiki) },
		{
			token: coreHostCapabilities.serverSetup,
			value: {
				async callIntegrationTool(
					expected: import("@leitwerk-dev/domain").ProcessInstance,
					projectKey: string,
					name: string,
					args: Record<string, unknown>,
					signal: AbortSignal,
				) {
					const process = input.baseDeps.processes.getById(expected.id);
					if (
						!process ||
						process.lifecycleStatus !== expected.lifecycleStatus ||
						process.selectedTurnId !== expected.selectedTurnId ||
						process.paramsJson !== expected.paramsJson ||
						process.stateJson !== expected.stateJson ||
						process.planRevision !== expected.planRevision
					)
						throw new Error("Process changed before maintenance delivery");
					const projects = input.baseDeps.projects.listByInstance(process.id);
					const project = projects.find((candidate) => candidate.key === projectKey);
					const turn = input.baseDeps.turnRecords.listByInstance(process.id).at(-1);
					if (!project || !turn)
						throw new Error(
							"Maintenance delivery requires a bound project and publication history",
						);
					return input.integrationTools.executeServer(
						name,
						{ ...args, projectKey },
						{
							process,
							projects,
							project,
							turn,
							idempotencyKey: `maintenance:${process.id}:${projectKey}:${name}`,
						},
						signal,
					);
				},
				get serverBaseUrl() {
					return input.config.server.base_url;
				},
				get processWorkspacesDir() {
					return path.resolve(input.config.storage.process_workspaces_dir);
				},
				components: input.config.components,
				externalWrites: input.baseDeps.externalWrites,
				publications: input.baseDeps.publications,
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
						opts?: NonNullable<Parameters<ProcessActionServiceLike["executeAction"]>[3]>,
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
				handoffDedupKeys: input.baseDeps.handoffDedupKeys,
				processWatchers: input.processWatcherService,
				launchRuns: {
					startProgrammatic(
						request: ProgrammaticLaunchRequestLike,
						opts: { idempotencyKey: string; actor?: Actor },
					) {
						return input.launchCoordinator.startProgrammatic(request, {
							idempotencyKey: opts.idempotencyKey,
							actor: opts.actor ?? SYSTEM_ACTOR,
						});
					},
					startWatcher<TConfig, TEvent>(
						watcher: RegisteredProcessWatcherLike<TConfig, TEvent>,
						event: TEvent,
						opts: { idempotencyKey: string; actor?: Actor },
					) {
						return input.launchCoordinator.startWatcher(watcher, event, {
							idempotencyKey: opts.idempotencyKey,
							actor: opts.actor ?? SYSTEM_ACTOR,
						});
					},
				},
				polling: input.polling,
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
