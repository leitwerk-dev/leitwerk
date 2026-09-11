import type { spawn } from "node:child_process";
import path from "node:path";
import cookie from "@fastify/cookie";
import {
	type DiscoveredExtensionEntry,
	type ExtensionCatalog,
	type LeitwerkRuntimeLane,
	serializeResolvedExtensionEntries,
	setupServerExtensions,
} from "@leitwerk-dev/extension-runtime";
import type {
	LauncherModelProfileSummary,
	ProcessLaunchPlanServiceLike,
	ProvidedCapability,
	ServerExtensionEventMap,
} from "@leitwerk-dev/process-sdk";
import type { ModelProfileSnapshot } from "@leitwerk-dev/protocol";
import { DEFAULT_SESSION_TRANSFER_LIMITS } from "@leitwerk-dev/session-transfer";
import { createPollingCoordinator, parseDurationMs } from "@leitwerk-dev/watcher-utils";
import {
	cleanupRetainedProcessVolumes,
	type ProcessStateExporter,
	type ProcessStateExportHelperRelayProvider,
	type ProcessVolume,
	planProcessVolumeRetentionCleanup,
	type WorkerRunner,
} from "@leitwerk-dev/worker-runners";
import Fastify, { type FastifyInstance } from "fastify";
import { createAuthService } from "./auth/auth-service.js";
import { getDefaultConfig, type LeitwerkConfig, validateConfig } from "./config/index.js";
import {
	closeDatabase,
	createDatabase,
	createInMemoryDatabase,
	type LeitwerkDb,
} from "./db/database.js";
import { createAllRepos, createCredentialCipherFromEnvironment } from "./db/repositories.js";
import { buildExtensionUiCatalog, type ExtensionUiCatalog } from "./extension-ui/catalog.js";
import { createExtensionHost, type ExtensionHost } from "./extensions/extension-host.js";
import { createExternalSourceService } from "./external-source-service.js";
import {
	createFutureExecutionLifecycle,
	type FutureExecutionLifecycle,
} from "./future-execution/index.js";
import { startFutureExecutionScheduler } from "./future-execution-scheduler.js";
import {
	createIntegrationToolRequestService,
	IntegrationToolRegistry,
} from "./integration-tool-registry.js";
import { createLaunchCoordinator, type LaunchCoordinator } from "./launch-coordinator.js";
import { createLaunchPipeline } from "./launch-pipeline.js";
import { createLauncherModelConfigService } from "./launcher-model-config-service.js";
import { createLauncherRecentValuesService } from "./launcher-recent-values-service.js";
import {
	createBuiltinPiServerAdapter,
	createModelProviderCredentialService,
	createModelProviderRegistry,
	createModelProviderServerAdapterRegistry,
	createModelStatusCache,
	defaultModelProviderCredentialStatus,
	type ModelProviderCredentialStatusResolver,
	type ModelProviderRegistry,
	type ModelProviderServerAdapterRegistry,
	type ModelStatusCache,
} from "./model-providers/index.js";
import {
	createPiResourceBundleCache,
	createPiResourceBundlePinReconciler,
} from "./pi-resources/index.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createProcessDeletionService } from "./process-deletion-service.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { reconcileProcessesOnStartup } from "./process-engine/startup-reconciliation.js";
import { prepareCreatedTurnStarts } from "./process-engine/turn-start-preflight.js";
import type { ProcessGraphRegistry } from "./process-graph.js";
import { createProcessFromLaunchPlan } from "./process-launch-executor.js";
import { buildProcessLauncherRegistry } from "./process-launcher-registry.js";
import { recoverModelAvailabilityFailures } from "./process-model-availability-recovery.js";
import { applyProcessModelAvailabilityTransitions } from "./process-model-availability-transitions.js";
import { reconcilePersistedProcessModelIntegrity } from "./process-model-integrity-reconciler.js";
import { createServerProcessModelPolicy } from "./process-model-policy/index.js";
import { createProcessModelSelection } from "./process-model-selection.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { listVisibleActionsForProcess as listVisibleOperatorActionsForProcess } from "./process-operator-attention.js";
import { createProcessQuestionService } from "./process-question-service.js";
import {
	assertProcessRuntimeAvailable,
	resolveKubernetesDockerConfig,
} from "./process-runtime-availability.js";
import {
	createFileBackedProcessSessionSnapshotStore,
	ProcessSessionReader,
} from "./process-session-store.js";
import {
	createProcessTitleGenerator,
	type ProcessTitleGenerator,
	TITLE_SYSTEM_PROMPT,
} from "./process-title-generator.js";
import { buildProcessUiRegistry } from "./process-ui-registry.js";
import { buildProcessWatcherRegistry } from "./process-watcher-registry.js";
import {
	createProjectMutationService,
	type ProjectMutationService,
} from "./project-mutation-service.js";
import { RepositoryCredentialService } from "./repository-credentials/service.js";
import { ResultImageStore } from "./result-image-store.js";
import type { RouteDeps } from "./routes/processes.js";
import { buildHostCapabilities } from "./server-bootstrap/build-host-capabilities.js";
import { loadServerExtensionCatalog } from "./server-bootstrap/load-extension-catalog.js";
import { registerHttp } from "./server-bootstrap/register-http.js";
import { registerWebsocket } from "./server-bootstrap/register-websocket.js";
import { resolveServerTlsOptions } from "./server-topology.js";
import { createProjectedSessionSnapshotStore } from "./session-summary-projection.js";
import { createSessionTransferHelperRelays } from "./session-transfer-helper-relays.js";
import { createSessionTransferService } from "./session-transfer-service.js";
import { createSkillCatalogService } from "./skills/catalog-service.js";
import { createDiagnosticTraceWriter } from "./supervisor/diagnostic-trace-writer.js";
import { createIpcHandler, type IpcHandler } from "./supervisor/ipc-handler.js";
import { startStaleHeartbeatWatchdog } from "./supervisor/stale-heartbeat-watchdog.js";
import { createWorkerSupervisor, type WorkerSupervisor } from "./supervisor/worker-supervisor.js";
import {
	createWorkerWebSocketIpcManager,
	type WorkerWebSocketIpcManager,
} from "./supervisor/worker-websocket-ipc.js";
import { createToolApprovalGate } from "./tool-approval-gate.js";
import { defaultWorkerRuntimeProfile } from "./worker-runtime-profile-selection.js";
import { type Broadcaster, createBroadcaster } from "./ws/broadcast.js";

export interface AppOptions {
	host?: string;
	port?: number;
	config?: LeitwerkConfig;
	db?: LeitwerkDb;
	logger?: boolean;
	extensionCatalog?: ExtensionCatalog | Promise<ExtensionCatalog>;
	resolvedExtensionEntries?: readonly DiscoveredExtensionEntry[];
	extensionLoadingStartDir?: string;
	/** Runtime lane override for extension UI assets. */
	extensionUiRuntimeLane?: LeitwerkRuntimeLane;
	/** Pre-provided capabilities injected before extensions are set up (e.g. fake adapters for testing). */
	preProvidedCapabilities?: readonly ProvidedCapability[];
	processTitleGenerator?: ProcessTitleGenerator;
	/** Test/custom seam for supplying a concrete container runner implementation. */
	workerRunnerRuntime?: {
		runner: WorkerRunner;
		volume?: ProcessVolume;
		exporter: ProcessStateExporter;
		webSocketIpc?: WorkerWebSocketIpcManager;
	};
	/** Local runner spawn seam for tests/dev only. */
	localWorkerSpawnImpl?: typeof spawn;
	/** Test seam shared by local Docker admission and worker startup. */
	localWorkerDockerPreflightImpl?: (timeoutMs: number) => Promise<void>;
	/** Credential-store seam. Declared credential providers default unavailable until it is wired. */
	modelProviderCredentialStatus?: ModelProviderCredentialStatusResolver;
}

export interface AppContext {
	app: FastifyInstance;
	db: LeitwerkDb;
	broadcaster: Broadcaster;
	config: LeitwerkConfig;
	deps: RouteDeps;
	extensionCatalog: ExtensionCatalog;
	modelProviderRegistry: ModelProviderRegistry;
	modelProviderServerAdapters: ModelProviderServerAdapterRegistry;
	modelStatusCache: ModelStatusCache;
	extensionUiCatalog: ExtensionUiCatalog;
	processGraphs: ProcessGraphRegistry;
	extensionHost: ExtensionHost;
	projectMutations: ProjectMutationService;
	ipcHandler: IpcHandler;
	supervisor: WorkerSupervisor;
	startBackgroundServices(): Promise<void>;
	stopBackgroundServices(): Promise<void>;
	isReady(): boolean;
}

function createConfiguredDatabase(config: LeitwerkConfig): LeitwerkDb {
	return config.storage.sqlite_path === ":memory:"
		? createInMemoryDatabase()
		: createDatabase({ sqlitePath: config.storage.sqlite_path });
}

function configuredExporterProfile(config: LeitwerkConfig): {
	image: string | undefined;
	imagePullPolicy: string | undefined;
} {
	const profileId = defaultWorkerRuntimeProfile(config);
	const profile = profileId ? config.worker_runtime_profiles?.[profileId] : undefined;
	return { image: profile?.image, imagePullPolicy: profile?.image_pull_policy };
}

async function createConfiguredWorkerRunnerRuntime(input: {
	config: LeitwerkConfig;
	webSocketIpc: WorkerWebSocketIpcManager;
	provided?: AppOptions["workerRunnerRuntime"];
	helperRelays: ProcessStateExportHelperRelayProvider;
	localWorkerSpawnImpl?: AppOptions["localWorkerSpawnImpl"];
	localWorkerDockerPreflightImpl?: AppOptions["localWorkerDockerPreflightImpl"];
}): Promise<{
	runner: WorkerRunner;
	volume?: ProcessVolume;
	exporter: ProcessStateExporter;
	webSocketIpc: WorkerWebSocketIpcManager;
}> {
	if (input.provided) {
		return {
			...input.provided,
			webSocketIpc: input.provided.webSocketIpc ?? input.webSocketIpc,
		};
	}
	if (input.config.workers.runner === "local") {
		const { createLocalWorkerRunner } = await import("@leitwerk-dev/worker-runners/local");
		const created = createLocalWorkerRunner({
			command: input.config.local_worker?.command,
			args: input.config.local_worker?.args,
			processWorkspacesDir: input.config.storage.process_workspaces_dir,
			treeFilesDir: input.config.storage.tree_files_dir,
			allowHostDocker: input.config.local_worker?.allow_host_docker,
			localWorkerSpawnImpl: input.localWorkerSpawnImpl,
			dockerPreflightImpl: input.localWorkerDockerPreflightImpl,
		});
		return { ...created, webSocketIpc: input.webSocketIpc };
	}
	if (input.config.workers.runner === "kubernetes") {
		const [{ createKubernetesWorkerRunner }, { createInClusterKubernetesApiClient }] =
			await Promise.all([
				import("@leitwerk-dev/worker-runners/kubernetes"),
				import("@leitwerk-dev/worker-runners/kubernetes-client"),
			]);
		const processVolume = input.config.kubernetes?.process_volume;
		const kubernetesDocker = resolveKubernetesDockerConfig(input.config);
		const pod = input.config.kubernetes?.pod;
		const exporterProfile = configuredExporterProfile(input.config);
		const kubernetesClient = createInClusterKubernetesApiClient({
			apiServerUrl: input.config.kubernetes?.api_server_url,
		});
		const created = createKubernetesWorkerRunner({
			client: kubernetesClient,
			processNamespacePrefix:
				input.config.kubernetes?.process_namespace_prefix ?? "leitwerk-process-",
			volume: {
				size: processVolume?.size ?? "20Gi",
				accessModes: processVolume?.access_modes ?? ["ReadWriteOnce"],
				mountPath: processVolume?.mount_path ?? "/state",
				...(processVolume?.storage_class_name
					? { storageClassName: processVolume.storage_class_name }
					: {}),
			},
			docker: kubernetesDocker,
			serverCaFile: input.config.kubernetes?.server_ca_file,
			serverNamespace: input.config.kubernetes?.server_namespace ?? "leitwerk-system",
			serverUrl: input.config.kubernetes?.server_url,
			exporterImage: exporterProfile.image,
			exporterImagePullPolicy: exporterProfile.imagePullPolicy,
			helperRelays: input.helperRelays,
			imagePullSecretCopies: input.config.kubernetes?.image_pull_secret_copies?.map((copy) => ({
				sourceName: copy.source_name,
				targetName: copy.target_name,
			})),
			pod: {
				workerServiceAccount: input.config.kubernetes?.worker_service_account,
				imagePullSecrets: input.config.kubernetes?.image_pull_secrets,
				...(pod
					? {
							annotations: pod.annotations,
							nodeSelector: pod.node_selector,
							tolerations: pod.tolerations,
							hostAliases: pod.host_aliases,
						}
					: {}),
			},
		});
		return { ...created, webSocketIpc: input.webSocketIpc };
	}
	const [{ createDockerWorkerRunner }, { createDockerEngineHttpClient }] = await Promise.all([
		import("@leitwerk-dev/worker-runners/docker"),
		import("@leitwerk-dev/worker-runners/docker-client"),
	]);
	const dockerVolume = input.config.docker?.process_volume;
	const exporterProfile = configuredExporterProfile(input.config);
	const created = createDockerWorkerRunner({
		engine: createDockerEngineHttpClient({
			socket: input.config.docker?.socket ?? "unix:///var/run/docker.sock",
		}),
		volume: {
			mode: dockerVolume?.mode ?? "bind",
			hostRoot: dockerVolume?.host_root ?? "/var/lib/leitwerk/processes",
			mountPath: dockerVolume?.mount_path ?? "/state",
		},
		defaultNetwork: input.config.docker?.network ?? "leitwerk",
		privateDaemonIsolation: input.config.docker?.private_daemon?.isolation,
		serverCaFile: input.config.docker?.server_ca_file,
		serverUrl: input.config.docker?.server_url,
		exporterImage: exporterProfile.image,
		helperRelays: input.helperRelays,
	});
	return { ...created, webSocketIpc: input.webSocketIpc };
}

export async function createApp(opts: AppOptions = {}): Promise<FastifyInstance> {
	const ctx = await createAppContext(opts);
	return ctx.app;
}

export async function createAppContext(opts: AppOptions = {}): Promise<AppContext> {
	const startupStartedAt = performance.now();
	let previousStartupMark = startupStartedAt;
	const config = opts.config ?? getDefaultConfig();
	const configErrors = validateConfig(config as unknown as Record<string, unknown>);
	if (configErrors.length > 0) {
		throw new Error(`Invalid config:\n${configErrors.join("\n")}`);
	}
	// Internal worker → server TLS (default off). Public UI/API HTTPS terminates
	// at a reverse proxy; this only secures the internal IPC listener.
	const tlsOptions = resolveServerTlsOptions(config);
	const app = Fastify({
		logger: opts.logger ?? true,
		...(tlsOptions
			? {
					https: {
						cert: tlsOptions.cert,
						key: tlsOptions.key,
						...(tlsOptions.ca !== undefined ? { ca: tlsOptions.ca } : {}),
						requestCert: tlsOptions.requestCert,
						rejectUnauthorized: tlsOptions.rejectUnauthorized,
					},
				}
			: {}),
	});
	const markStartup = (stage: string): void => {
		const now = performance.now();
		app.log.info(
			{
				startupStage: stage,
				stageDurationMs: Math.round((now - previousStartupMark) * 10) / 10,
				totalDurationMs: Math.round((now - startupStartedAt) * 10) / 10,
			},
			"Server startup stage complete",
		);
		previousStartupMark = now;
	};
	await app.register(cookie);
	markStartup("fastify_plugins");
	const ownsDb = !opts.db;
	const db = opts.db ?? createConfiguredDatabase(config);
	markStartup("database");
	const { resolvedExtensionEntries, extensionCatalog } = await loadServerExtensionCatalog({
		config,
		extensionCatalog: opts.extensionCatalog,
		resolvedExtensionEntries: opts.resolvedExtensionEntries,
		extensionLoadingStartDir: opts.extensionLoadingStartDir,
	});
	markStartup("extension_catalog");
	const modelProviderRegistry = createModelProviderRegistry({
		sets: extensionCatalog.modelProviders,
		piContributions: extensionCatalog.piContributions,
		extensionConfig: config.extensions ?? {},
		modelProfiles: config.pi.model_profiles,
		titleModelProfileId: config.pi.process_title_generation.model_profile,
	});
	const credentialCipher = createCredentialCipherFromEnvironment();
	const repos = createAllRepos(db, {
		...(credentialCipher ? { credentialCipher } : {}),
	});
	repos.transaction((transactionRepos) => {
		// Directly configured skills are no longer supported. Deactivate any left by an older release.
		transactionRepos.skills.reconcile([]);
		transactionRepos.skills.backfillDependencies();
	});
	const skillCatalog = createSkillCatalogService({
		repositories: config.skill_repositories ?? [],
		repos,
	});
	await skillCatalog.refresh();
	markStartup("skill_catalog");
	if (!credentialCipher && repos.providerCredentials.count() > 0) {
		throw new Error(
			"Encrypted provider credentials exist but LEITWERK_CREDENTIAL_ENCRYPTION_KEY is unavailable",
		);
	}
	const modelProviderCredentials = createModelProviderCredentialService({
		registry: modelProviderRegistry,
		repo: repos.providerCredentials,
	});
	modelProviderCredentials.initialize();
	const modelStatusCache = createModelStatusCache({
		registry: modelProviderRegistry,
		modelProfiles: config.pi.model_profiles,
		credentialStatus:
			opts.modelProviderCredentialStatus ??
			(modelProviderRegistry.size > 0
				? modelProviderCredentials.status
				: defaultModelProviderCredentialStatus),
	});
	await modelStatusCache.refresh();
	const modelProviderServerAdapters = await createModelProviderServerAdapterRegistry({
		registry: modelProviderRegistry,
		modelProfiles: config.pi.model_profiles,
		credentials: modelProviderCredentials,
		createBuiltinAdapter: (providerId) => createBuiltinPiServerAdapter(providerId),
	});
	const piResourceBundles = createPiResourceBundleCache();
	const piResourceBundlePins = createPiResourceBundlePinReconciler({
		turnStarts: repos.turnStarts,
		turnRecords: repos.turnRecords,
		bundleCache: piResourceBundles,
	});
	markStartup("model_providers");

	const broadcaster = createBroadcaster();
	const processOperations = createProcessOperationCoordinator();
	const processGraphs = extensionCatalog.processes;
	const processActionRegistry = buildProcessActionRegistry(extensionCatalog);
	const integrationTools = new IntegrationToolRegistry();
	const processUiRegistry = buildProcessUiRegistry(extensionCatalog);
	const processModelPolicy = createServerProcessModelPolicy({
		config,
		processGraphs,
		processActionRegistry,
	});
	const extensionUiCatalog = await buildExtensionUiCatalog(
		extensionCatalog.modules,
		opts.extensionUiRuntimeLane ? { runtimeLane: opts.extensionUiRuntimeLane } : {},
	);
	markStartup("extension_ui_catalog");
	const launcherModelProfiles: LauncherModelProfileSummary[] = config.pi.model_profiles.map(
		(profile: ModelProfileSnapshot): LauncherModelProfileSummary => ({
			id: profile.id,
			provider: profile.provider,
			modelId: profile.model_id,
			thinkingLevel: profile.thinking_level ?? "off",
		}),
	);
	const launcherModelProfilesById = new Map(
		launcherModelProfiles.map((profile) => [profile.id, profile] as const),
	);
	const getModelProfilesForProcess = (processId: string) => {
		return processModelPolicy
			.project({
				kind: "profile_options",
				processId,
				availability: modelStatusCache.snapshot(),
			})
			.map((profile) => launcherModelProfilesById.get(profile.id))
			.filter(
				(
					profile: LauncherModelProfileSummary | undefined,
				): profile is LauncherModelProfileSummary => profile !== undefined,
			);
	};
	const launcherService = buildProcessLauncherRegistry(extensionCatalog, {
		modelProfiles: launcherModelProfiles,
		commitMessages: config.commit_messages,
		getModelProfilesForProcess,
	});
	const processWatcherService = buildProcessWatcherRegistry(extensionCatalog, config, {
		modelProfiles: launcherModelProfiles,
		getModelProfilesForProcess,
		processModelPolicy,
	});
	const workerWebSocketIpc = createWorkerWebSocketIpcManager();
	// This window must open before listen(): workers from the previous server
	// process can reconnect as soon as the socket accepts connections, before
	// startup adoption has registered their worker ids.
	workerWebSocketIpc.setUnknownWorkerConnectionsRetryable(true);
	const serverEpoch = `epoch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
	const sessionSnapshots = createProjectedSessionSnapshotStore(
		createFileBackedProcessSessionSnapshotStore(config.storage.tree_files_dir),
		repos,
	);
	for (const process of repos.processes.listAll()) await sessionSnapshots.backfill(process.id);
	const sessionReader = new ProcessSessionReader(sessionSnapshots);
	const resultImages = new ResultImageStore({
		rootDir: path.join(config.storage.tree_files_dir, "result-images"),
	});
	const authService = createAuthService({ config, repos });
	await registerWebsocket(app, broadcaster, workerWebSocketIpc, authService);
	const extensionHost = createExtensionHost<ServerExtensionEventMap>();
	let launchCoordinator: LaunchCoordinator | undefined;
	let applyGeneratedFutureExecutionTitle: NonNullable<
		Parameters<typeof createProcessTitleGenerator>[0]["futureExecutionTitleApplier"]
	> = async () => ({
		kind: "failed",
		error: "Future execution lifecycle is not initialized",
	});
	const processTitles: ProcessTitleGenerator | undefined =
		opts.processTitleGenerator ??
		(config.pi.process_title_generation.model_profile === null
			? undefined
			: createProcessTitleGenerator({
					config,
					repos,
					broadcaster,
					extensionHost,
					futureExecutionTitleApplier: (input) => applyGeneratedFutureExecutionTitle(input),
					getLaunchCoordinator: () => launchCoordinator,
					logger: {
						warn: (message, details) => app.log.warn(details ?? {}, message),
					},
					runtime: {
						generateTitle: ({ prompt, maxTokens, providerOptions }) =>
							modelProviderServerAdapters.generateText({
								profileId: config.pi.process_title_generation.model_profile as string,
								prompt,
								systemPrompt: TITLE_SYSTEM_PROMPT,
								maxTokens,
								request: providerOptions,
							}),
					},
				}));

	const baseDeps = {
		...repos,
		broadcaster,
		processOperations,
	};
	let invalidateExternalSourceArmings: ((instanceId: string) => void) | null = null;
	const projectMutations = createProjectMutationService({
		projects: baseDeps.projects,
		transaction: baseDeps.transaction,
		broadcaster,
		onProjectMutated: (project) => invalidateExternalSourceArmings?.(project.instanceId),
	});
	const launcherRecentValues = createLauncherRecentValuesService({
		repos: baseDeps,
		launcherService,
	});
	const launchPlans: ProcessLaunchPlanServiceLike = {
		async prepare(launchPlan, opts = {}) {
			return processModelPolicy.prepareLaunchPlan(launchPlan, opts);
		},
	};
	const launcherModelConfigs = createLauncherModelConfigService({
		launcherService,
		launchPlans,
		processModelPolicy,
		modelStatusCache,
	});
	const polling = createPollingCoordinator(app.log);

	let backgroundServicesStarted = false;
	let backgroundServicesReady = false;
	let startupReconciliationCompleted = false;
	const startHooks: Array<() => void | Promise<void>> = [];
	const stopHooks: Array<() => void | Promise<void>> = [];
	let modelStatusRefreshTimer: NodeJS.Timeout | null = null;
	let futureExecutionLifecycle: FutureExecutionLifecycle;
	async function refreshModelStatusAndApplyTransitions(): Promise<void> {
		const snapshot = await modelStatusCache.refresh();
		await applyProcessModelAvailabilityTransitions({
			snapshot,
			reconcileFutureExecutions: async (profileIds) => {
				await futureExecutionLifecycle.reconcileModelAvailability({
					availability: snapshot,
					profileIds,
				});
			},
			recoverProcesses: async (profileIds) => {
				await recoverModelAvailabilityFailures({
					processes: baseDeps.processes,
					turnStarts: baseDeps.turnStarts,
					commands: processEngine,
					policy: processModelPolicy,
					availability: snapshot,
					cause: "availability_transition",
					profileIds,
					logger: app.log,
				});
			},
		});
	}
	startHooks.push(() => {
		if (modelProviderRegistry.size === 0) return;
		modelStatusRefreshTimer = setInterval(() => {
			void refreshModelStatusAndApplyTransitions().catch((error: unknown) => {
				app.log.warn({ error }, "Model provider status refresh failed");
			});
		}, 15_000);
	});
	stopHooks.push(() => {
		if (modelStatusRefreshTimer) clearInterval(modelStatusRefreshTimer);
		modelStatusRefreshTimer = null;
	});
	let stopAuthSweep: (() => void) | null = null;
	startHooks.push(() => {
		stopAuthSweep = authService.startExpiredAuthStateSweep();
	});
	stopHooks.push(() => {
		stopAuthSweep?.();
		stopAuthSweep = null;
	});

	async function startBackgroundServices(): Promise<void> {
		if (backgroundServicesStarted) {
			return;
		}

		if (!startupReconciliationCompleted) {
			if (!supervisor) {
				throw new Error("worker supervisor not initialized");
			}
			workerWebSocketIpc.setUnknownWorkerConnectionsRetryable(true);
			try {
				await futureExecutionLifecycle.reconcileModelAvailability({
					availability: modelStatusCache.snapshot(),
				});
				await recoverModelAvailabilityFailures({
					processes: baseDeps.processes,
					turnStarts: baseDeps.turnStarts,
					commands: processEngine,
					policy: processModelPolicy,
					availability: modelStatusCache.snapshot(),
					cause: "startup_reconciliation",
					logger: app.log,
				});
				await reconcilePersistedProcessModelIntegrity({
					processes: baseDeps.processes,
					commands: processEngine,
					policy: processModelPolicy,
					logger: app.log,
				});
				await supervisor.adoptRegisteredWorkers();
				await reconcileProcessesOnStartup({
					config,
					processes: baseDeps.processes,
					leases: baseDeps.leases,
					turnStarts: baseDeps.turnStarts,
					turnRecords: baseDeps.turnRecords,
					broadcaster,
					supervisor,
					commands: processEngine,
					bundlePins: piResourceBundlePins,
					processActionRegistry,
					logger: app.log,
				});
				startupReconciliationCompleted = true;
			} finally {
				workerWebSocketIpc.setUnknownWorkerConnectionsRetryable(false);
			}
		}

		backgroundServicesStarted = true;
		try {
			for (const hook of startHooks) {
				await hook();
			}
			backgroundServicesReady = true;
		} catch (error) {
			backgroundServicesReady = false;
			backgroundServicesStarted = false;
			for (const hook of [...stopHooks].reverse()) {
				await hook();
			}
			throw error;
		}
	}

	async function stopBackgroundServices(): Promise<void> {
		backgroundServicesReady = false;
		if (!backgroundServicesStarted) {
			return;
		}
		backgroundServicesStarted = false;
		for (const hook of [...stopHooks].reverse()) {
			await hook();
		}
	}

	let supervisor: WorkerSupervisor | undefined;
	let isNewTurnBlocked = (_instanceId: string): boolean => false;
	const afterSuccessHooks = new Set<(instanceId: string) => void | Promise<void>>();
	const toastTtlMs = parseDurationMs(config.server.websocket.toast_ttl, 6_000, {
		allowHours: true,
	});
	const processEngine = createProcessEngine({
		processes: baseDeps.processes,
		events: baseDeps.events,
		futureExecutions: baseDeps.futureExecutions,
		projects: baseDeps.projects,
		inputs: baseDeps.inputs,
		pendingExternalSourceFires: baseDeps.pendingExternalSourceFires,
		leafOutcomeSnapshots: baseDeps.leafOutcomeSnapshots,
		questionRequests: baseDeps.questionRequests,
		turnRecords: baseDeps.turnRecords,
		turnStarts: baseDeps.turnStarts,
		leases: baseDeps.leases,
		turnAnnotations: baseDeps.turnAnnotations,
		transaction: baseDeps.transaction,
		broadcaster,
		config,
		toastTtlMs,
		processOperations,
		getSupervisor: () => supervisor,
		extensionHost,
		processGraphs,
		sessionReader,
		getProcessActionRegistry: () => processActionRegistry,
		getProcessUiRegistry: () => processUiRegistry,
		logger: app.log,
		processModelPolicy,
		getModelAvailabilitySnapshot: () => modelStatusCache.snapshot(),
		afterRecord(process) {
			// The process volume is the durable source for an already-created start.
			// A missing server-cache entry is valid after restart.
			piResourceBundlePins.reconcile(process);
			toolApprovalGate.reconcile(process.id);
		},
		afterSuccessHooks,
		isNewTurnBlocked: (instanceId) => isNewTurnBlocked(instanceId),
		prepareTurnStarts: (process, writes, providerOptions, availabilitySnapshot) =>
			prepareCreatedTurnStarts(
				{
					config,
					registry: modelProviderRegistry,
					modelStatusCache,
					piContributions: extensionCatalog.piContributions,
					bundleCache: piResourceBundles,
					projects: baseDeps.projects,
					processSkills: baseDeps.processSkills,
				},
				process,
				writes,
				providerOptions,
				availabilitySnapshot,
			),
	});

	const processQuestions = createProcessQuestionService({
		repos: baseDeps,
		processOperations,
		broadcaster,
		getWorkerId: (instanceId) => supervisor?.getWorker(instanceId)?.workerId ?? null,
		sendQuestionResponse: (instanceId, workerId, payload) =>
			supervisor?.questionResponse(instanceId, workerId, payload),
		emitQuestionRequested: (request) =>
			extensionHost
				.emit("question_requested", { instanceId: request.instanceId, request })
				.catch((error) =>
					app.log.error(
						{ error, instanceId: request.instanceId },
						"Question delivery event failed",
					),
				),
	});

	const toolApprovalGate = createToolApprovalGate({
		repos: baseDeps,
		processOperations,
	});
	const integrationToolRequests = createIntegrationToolRequestService({
		registry: integrationTools,
		repos: baseDeps,
		processActionRegistry,
		toolApprovalGate,
	});
	const diagnosticTraceWriter = createDiagnosticTraceWriter(
		path.join(config.storage.tree_files_dir, "diagnostic-traces"),
	);
	const ipcHandler = createIpcHandler(
		{
			processes: baseDeps.processes,
			getLaunchCoordinator: () => launchCoordinator,
			projects: baseDeps.projects,
			inputs: baseDeps.inputs,
			events: baseDeps.events,
			leases: baseDeps.leases,
			turnRecords: baseDeps.turnRecords,
			handleIntegrationToolRequest: (instanceId, payload) =>
				integrationToolRequests.handle(instanceId, payload),
			handleIntegrationToolCancel: (instanceId, payload) =>
				void integrationToolRequests.cancel(instanceId, payload),
			processQuestions,
			broadcaster,
			commands: processEngine,
			updateCredential: ({ providerId, expectedRevision, values }) => {
				const result = modelProviderCredentials.compareAndSet({
					providerId,
					expectedRevision,
					value: values,
				});
				if (result.accepted) {
					void refreshModelStatusAndApplyTransitions().catch((error: unknown) => {
						app.log.warn(
							{ error, providerId },
							"Model status refresh after credential update failed",
						);
					});
				}
				return result;
			},
			appendDiagnosticTrace(instanceId, text) {
				try {
					diagnosticTraceWriter.append(instanceId, text);
				} catch (error) {
					app.log.warn({ error, instanceId }, "Could not append worker diagnostic trace");
				}
			},
			workerEventLogger: config.workers.log_worker_events_to_stdout
				? (entry) => {
						// Worker IPC is WebSocket-only; terminal visibility comes from mirroring
						// worker.event payloads through the server's own logger.
						app.log.info({ source: "worker_event", ...entry }, "worker.event");
					}
				: undefined,
		},
		{
			onTurnTerminalRecorded(instanceId, workerId, turnRecordId) {
				supervisor?.acknowledgeTurnTerminal(instanceId, workerId, { turnRecordId });
			},
			onTurnFailedRecorded(input) {
				app.log.warn(input, "Worker turn failed");
			},
			onTurnTerminalRecordingFailed(input) {
				app.log.error(input, "Worker turn terminal recording failed");
				baseDeps.events.create({
					instanceId: input.instanceId,
					eventType: "worker_terminal_recording_failed",
					data: {
						workerId: input.workerId,
						turnRecordId: input.turnRecordId,
						terminalType: input.terminalType,
						code: input.code,
						message: input.message,
					},
				});
			},
			onWorkerTurnStartAccepted(instanceId, workerId, payload) {
				supervisor?.acceptTurnStart(
					instanceId,
					workerId,
					payload.startRecordId,
					payload.turnRecordId,
				);
			},
			onCredentialUpdateResult(instanceId, workerId, payload) {
				supervisor?.credentialUpdateResult(instanceId, workerId, payload);
			},
			onIntegrationToolResult(instanceId, workerId, payload) {
				supervisor?.integrationToolResult(instanceId, workerId, payload);
			},
		},
	);

	const repositoryCredentials = new RepositoryCredentialService(extensionCatalog.processes);
	const sessionTransferLimits = config.session_transfer
		? {
				maxEntries: config.session_transfer.max_entries,
				maxLogicalBytes: config.session_transfer.max_logical_bytes,
				maxCompressedBytes: config.session_transfer.max_compressed_bytes,
			}
		: DEFAULT_SESSION_TRANSFER_LIMITS;
	const sessionTransferHelperRelays = createSessionTransferHelperRelays({
		repos: baseDeps,
		limits: sessionTransferLimits,
	});
	const supervisorConfig = config;
	const runnerRuntime = await createConfiguredWorkerRunnerRuntime({
		config: supervisorConfig,
		webSocketIpc: workerWebSocketIpc,
		provided: opts.workerRunnerRuntime,
		helperRelays: sessionTransferHelperRelays,
		localWorkerSpawnImpl: opts.localWorkerSpawnImpl,
		localWorkerDockerPreflightImpl: opts.localWorkerDockerPreflightImpl,
	});
	markStartup("worker_runner");
	supervisor = createWorkerSupervisor({
		config: supervisorConfig,
		processGraphs,
		processActionRegistry,
		processModelPolicy,
		ipcHandler,
		leases: baseDeps.leases,
		getLaunchCoordinator: () => launchCoordinator,
		processes: baseDeps.processes,
		projects: baseDeps.projects,
		inputs: baseDeps.inputs,
		turnRecords: baseDeps.turnRecords,
		turnStarts: baseDeps.turnStarts,
		events: baseDeps.events,
		broadcaster,
		runnerRuntime,
		logger: app.log,
		resolvedExtensionEntriesJson: serializeResolvedExtensionEntries(resolvedExtensionEntries),
		serverEpoch,
		resolveResourceBundle(digest) {
			return piResourceBundles.get(digest);
		},
		resolveRepositoryCredentials: (input) => repositoryCredentials.resolveWorkerCredentials(input),
		integrationTools,
		resolveCredential: (providerId, options) =>
			modelProviderCredentials.resolve(providerId, options),
	});

	let staleHeartbeatWatchdog: ReturnType<typeof startStaleHeartbeatWatchdog> | null = null;
	let retainedVolumeCleanupTimer: NodeJS.Timeout | null = null;
	let retainedVolumeCleanupRunning = false;
	const releasedRetainedVolumes = new Set<string>();
	async function runRetainedVolumeCleanup(): Promise<void> {
		if (retainedVolumeCleanupRunning) return;
		retainedVolumeCleanupRunning = true;
		const processes = baseDeps.processes.listAll();
		const now = new Date();
		const policy = {
			completedProcessRetention: config.workers.cleanup.completed_process_retention,
			errorProcessRetention: config.workers.cleanup.error_process_retention,
		};
		const expiredImageProcesses = new Set(
			planProcessVolumeRetentionCleanup({ processes, now, policy }),
		);
		try {
			const released = await cleanupRetainedProcessVolumes({
				volume: runnerRuntime.volume,
				processes,
				now,
				policy,
				alreadyReleased: releasedRetainedVolumes,
			});
			for (const instanceId of released) releasedRetainedVolumes.add(instanceId);
		} catch (error) {
			app.log.warn({ error }, "retained process volume cleanup failed");
		}
		try {
			await resultImages.cleanupProcesses({
				// Refresh after volume cleanup so a process created during the sweep is
				// never mistaken for an orphan.
				retainedInstanceIds: new Set(baseDeps.processes.listAll().map((process) => process.id)),
				expiredInstanceIds: expiredImageProcesses,
			});
		} catch (error) {
			app.log.warn({ error }, "retained result image cleanup failed");
		} finally {
			retainedVolumeCleanupRunning = false;
		}
	}
	startHooks.push(() => {
		if (!supervisor) {
			throw new Error("worker supervisor not initialized");
		}
		void runRetainedVolumeCleanup();
		const cleanupIntervalMs = Math.max(
			60_000,
			parseDurationMs(config.workers.cleanup.transient_ttl, 3_600_000, { allowHours: true }),
		);
		retainedVolumeCleanupTimer = setInterval(
			() => void runRetainedVolumeCleanup(),
			cleanupIntervalMs,
		);
		staleHeartbeatWatchdog = startStaleHeartbeatWatchdog({
			leases: baseDeps.leases,
			processes: baseDeps.processes,
			turnRecords: baseDeps.turnRecords,
			turnStarts: baseDeps.turnStarts,
			ipcHandler,
			supervisor,
			staleHeartbeatTimeout: config.workers.stale_heartbeat_timeout,
		});
	});
	stopHooks.push(() => {
		staleHeartbeatWatchdog?.stop();
		staleHeartbeatWatchdog = null;
		if (retainedVolumeCleanupTimer) {
			clearInterval(retainedVolumeCleanupTimer);
			retainedVolumeCleanupTimer = null;
		}
	});

	if (processTitles?.start) {
		startHooks.push(() => processTitles.start?.());
	}
	if (processTitles?.close) {
		stopHooks.push(() => processTitles.close?.());
	}

	const launchPipeline = createLaunchPipeline({
		launchRuns: baseDeps.launchRuns,
		broadcaster,
		titleGenerationAvailable: Boolean(processTitles),
		logger: app.log,
	});
	const processLaunchDeps = {
		...baseDeps,
		broadcaster,
		commands: processEngine,
		processTitles,
		extensionHost,
		logger: app.log,
		repositoryCredentials,
		getSupervisor: () => supervisor,
		assertRuntimeAvailable: (processId: string) =>
			assertProcessRuntimeAvailable(
				{
					config,
					processes: extensionCatalog.processes,
					dockerInfo: opts.localWorkerDockerPreflightImpl,
				},
				processId,
			),
	};
	const createProcess = createProcessFromLaunchPlan.bind(null, processLaunchDeps);
	futureExecutionLifecycle = createFutureExecutionLifecycle({
		futureExecutions: baseDeps.futureExecutions,
		processes: baseDeps.processes,
		projects: baseDeps.projects,
		processRelations: baseDeps.processRelations,
		handoffDedupKeys: baseDeps.handoffDedupKeys,
		turnRecords: baseDeps.turnRecords,
		skills: baseDeps.skills,
		processSkills: baseDeps.processSkills,
		transaction: baseDeps.transaction,
		broadcaster,
		commands: processEngine,
		processOperations,
		processTitles,
		extensionHost,
		launcherService,
		launcherRecentValues,
		processGraphs,
		processActionRegistry: processActionRegistry ?? undefined,
		processModelPolicy,
		launchPlans,
		modelStatusCache,
		launchPipeline,
		assertRuntimeAvailable: (processId) =>
			assertProcessRuntimeAvailable(
				{
					config,
					processes: extensionCatalog.processes,
					dockerInfo: opts.localWorkerDockerPreflightImpl,
				},
				processId,
			),
		logger: app.log,
	});
	applyGeneratedFutureExecutionTitle = (input) =>
		futureExecutionLifecycle.applyGeneratedFutureLaunchTitleIfUnchanged(input);
	launchCoordinator = createLaunchCoordinator({
		commands: processEngine,
		launchRuns: baseDeps.launchRuns,
		processes: baseDeps.processes,
		leases: baseDeps.leases,
		turnRecords: baseDeps.turnRecords,
		turnStarts: baseDeps.turnStarts,
		titleJobs: baseDeps.titleJobs,
		launcherService,
		futureExecutionLifecycle,
		launchPipeline,
		launchPlans,
		createProcessFromLaunchPlan: createProcess,
		titleGenerationAvailable: Boolean(processTitles),
		logger: app.log,
	});
	startHooks.push(() => launchCoordinator?.reconcileIncomplete());
	const futureExecutionScheduler = startFutureExecutionScheduler(futureExecutionLifecycle);
	startHooks.push(() => futureExecutionScheduler.start());
	stopHooks.push(() => futureExecutionScheduler.stop());
	const externalSourceService = createExternalSourceService({
		processes: baseDeps.processes,
		projects: baseDeps.projects,
		pendingExternalSourceFires: baseDeps.pendingExternalSourceFires,
		commands: processEngine,
		processActionRegistry,
	});
	invalidateExternalSourceArmings = (instanceId) =>
		externalSourceService.invalidateArmings(instanceId);
	startHooks.push(() => externalSourceService.reconcileAllArmings());
	afterSuccessHooks.add(async (instanceId) => {
		const process = baseDeps.processes.getById(instanceId);
		if (process) piResourceBundlePins.reconcile(process);
		await externalSourceService.reconcileArmings(instanceId);
		await externalSourceService.drainQueued(instanceId);
	});

	if (!supervisor) throw new Error("worker supervisor not initialized");
	const deletionPending = new Set<string>();
	const sessionTransfers = createSessionTransferService({
		repos: baseDeps,
		processOperations,
		supervisor,
		exporter: runnerRuntime.exporter,
		helperRelays: sessionTransferHelperRelays,
		sessionSource: sessionSnapshots,
		config,
		limits: sessionTransferLimits,
		logger: app.log,
		isDeletionPending: (instanceId) => deletionPending.has(instanceId),
		onUpdated: (attempt) => {
			broadcaster.sendDurable(
				"session_transfer.updated",
				{ attemptId: attempt.id },
				attempt.instanceId,
			);
		},
	});
	isNewTurnBlocked = (instanceId) => {
		const attempt = sessionTransfers.activeForProcess(instanceId);
		return attempt?.state === "queued" || attempt?.state === "exporting";
	};
	startHooks.push(async () => {
		await sessionTransfers.reconcile();
		sessionTransfers.start();
	});
	stopHooks.push(() => sessionTransfers.stop());
	const processDeletion = createProcessDeletionService({
		processes: baseDeps.processes,
		processEngine,
		processOperations,
		supervisor,
		volume: runnerRuntime.volume,
		sessionSnapshots,
		resultImages,
		sessionTransfers,
		deletionPending,
		broadcaster,
		logger: app.log,
	});

	const processActionListDeps = {
		projects: baseDeps.projects,
		futureExecutions: baseDeps.futureExecutions,
		turnRecords: baseDeps.turnRecords,
		turnStarts: baseDeps.turnStarts,
		processGraphs,
		processActionRegistry,
	};
	const processModelSelection = createProcessModelSelection({
		processGraphs,
		processActionRegistry,
		processes: baseDeps.processes,
		projects: baseDeps.projects,
		scheduledActions: baseDeps.futureExecutions,
		turnRecords: baseDeps.turnRecords,
		turnStarts: baseDeps.turnStarts,
		instanceTrees: sessionReader,
		processModelPolicy,
		modelStatusCache,
	});
	const hostCapabilities = buildHostCapabilities({
		config,
		baseDeps,
		projectMutations,
		commands: processEngine,
		getSupervisor: () => supervisor,
		listVisibleActionsForProcess(instanceId: string) {
			const process = baseDeps.processes.getById(instanceId);
			return process ? listVisibleOperatorActionsForProcess(processActionListDeps, process) : [];
		},
		launcherService,
		launcherRecentValues,
		launcherModelConfigs,
		launchPlans,
		processWatcherService,
		polling,
		externalSourceService,
		processModelSelection,
		resultImages,
		repositoryCredentials,
		processQuestions,
		launchCoordinator,
		preProvidedCapabilities: opts.preProvidedCapabilities,
	});

	await setupServerExtensions(
		extensionCatalog,
		{
			events: extensionHost,
			logger: app.log,
			provide: hostCapabilities.provide.bind(hostCapabilities),
			get: hostCapabilities.get.bind(hostCapabilities),
			require: hostCapabilities.require.bind(hostCapabilities),
			tool: (definition) => integrationTools.register(definition),
			onStart(handler: () => void | Promise<void>) {
				startHooks.push(handler);
			},
			onStop(handler: () => void | Promise<void>) {
				stopHooks.push(handler);
			},
		},
		(id: string) => config.extensions?.[id],
	);
	startHooks.push(() => polling.start());
	stopHooks.push(() => polling.stop());
	for (const process of extensionCatalog.processes.values()) {
		for (const [turnId, binding] of process.turns) {
			const definition = binding.definition;
			if (definition.kind !== "llm" || !definition.integrationTools?.length) continue;
			try {
				integrationTools.declarations(definition.integrationTools);
			} catch (error) {
				throw new Error(
					`Invalid integration tools for process '${process.id}' turn '${turnId}': ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	markStartup("server_extensions");

	const deps: RouteDeps = {
		...baseDeps,
		launchCoordinator,
		processGraphs,
		supervisor,
		processEngine,
		processQuestions,
		toolApprovalGate,
		processDeletion,
		processActionRegistry,
		processUiRegistry,
		extensionHost,
		launcherService,
		launcherRecentValues,
		launchPlans,
		processTitles,
		toolRenderers: extensionCatalog.toolRenderers,
		config,
		sessionReader,
		futureExecutionLifecycle,
		modelProviderRegistry,
		modelProviderCredentialStatus: modelProviderCredentials.status,
		modelStatusCache,
		processModelPolicy,
		processModelSelection,
		skillCatalog,
		sessionTransferService: sessionTransfers,
	};

	registerHttp({
		app,
		isReady: () => backgroundServicesReady,
		deps,
		authService,
		processWatcherService,
		extensionUiCatalog,
		integrationTools,
		sessionSnapshots,
		resultImages,
		maxSessionSnapshotBytes: config.workers.session_snapshot_max_size_bytes,
		extensionUiAssetCacheControl:
			process.env.LEITWERK_RUNTIME_LANE === "source" ? "no-store" : undefined,
	});
	markStartup("routes_ready");

	let workersClosedForServerShutdown = false;
	async function closeWorkersForServerShutdown(): Promise<void> {
		if (workersClosedForServerShutdown) {
			return;
		}
		workersClosedForServerShutdown = true;
		if (!supervisor) {
			return;
		}
		if (config.workers.runner === "local") {
			await supervisor.shutdownAll("server_shutdown");
		} else {
			await supervisor.detachAll("server_shutdown");
		}
	}

	app.addHook("preClose", async () => {
		await stopBackgroundServices();
		await closeWorkersForServerShutdown();
	});

	app.addHook("onClose", async () => {
		try {
			await stopBackgroundServices();
			await closeWorkersForServerShutdown();
		} finally {
			if (ownsDb) {
				closeDatabase(db);
			}
		}
	});

	return {
		app,
		db,
		broadcaster,
		config,
		deps,
		extensionCatalog,
		modelProviderRegistry,
		modelProviderServerAdapters,
		modelStatusCache,
		extensionUiCatalog,
		processGraphs,
		extensionHost,
		projectMutations,
		ipcHandler,
		supervisor,
		startBackgroundServices,
		stopBackgroundServices,
		isReady: () => backgroundServicesReady,
	};
}
