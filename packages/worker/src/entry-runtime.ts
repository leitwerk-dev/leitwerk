import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
	buildExtensionCatalog,
	createCatalogWorkerDefinitionResolver,
	type ExtensionCatalog,
	importExtensionModules,
	parseResolvedExtensionEntries,
	RUNTIME_EXTENSION_ALLOWED_ROOTS_ENV,
	RUNTIME_EXTENSION_ENTRIES_ENV,
	setupWorkerExtensions,
} from "@leitwerk-dev/extension-runtime";
import {
	createCapabilityAccessor,
	createEventBus,
	type WorkerExtensionAPI,
} from "@leitwerk-dev/process-sdk";
import {
	RESULT_IMAGE_MAX_SIZE_BYTES,
	WORKER_ID_ENV,
	WORKER_INSTANCE_ID_ENV,
	WORKER_IPC_CONNECT_TOKEN_ENV,
	WORKER_IPC_RECONNECT_ENV,
	WORKER_IPC_SERVER_URL_ENV,
	WORKER_SNAPSHOT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import {
	entriesExistWithinAllowedRoots,
	parseExtensionAllowedRoots,
} from "./extension-entry-roots.js";
import { createWorkerIpcFromEnvironment, type WorkerIpc } from "./ipc.js";
import { type PiTreeHandleFactory, SdkPiTreeHandleFactory } from "./pi-adapter.js";
import { createUploadResultImagesTool } from "./result-image-upload.js";
import {
	createWorkerRuntime,
	nodeWorkerRuntimeScheduler,
	type WorkerRuntime,
	type WorkerRuntimeAdapters,
	type WorkerRuntimeConfig,
	type WorkerRuntimeScheduler,
} from "./runtime/index.js";
import {
	createWorkerSessionSnapshotExchangeFromEnv,
	type WorkerSessionSnapshotExchange,
} from "./session-snapshot-exchange.js";
import { NodeRunRootGitOps } from "./workspace/node-run-root-git-ops.js";
import type { RunRootGitOps } from "./workspace/run-root.js";

let runtimeCatalogPromise: Promise<ExtensionCatalog> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listWorkspacePatterns(workspaces: unknown): string[] {
	if (Array.isArray(workspaces)) {
		return workspaces.filter((value): value is string => typeof value === "string");
	}
	if (isRecord(workspaces) && Array.isArray(workspaces.packages)) {
		return workspaces.packages.filter((value): value is string => typeof value === "string");
	}
	return [];
}

function findWorkspaceRoot(startDir: string): string | null {
	let current = path.resolve(startDir);
	while (true) {
		const packageJsonPath = path.join(current, "package.json");
		if (existsSync(packageJsonPath)) {
			try {
				const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
					workspaces?: unknown;
				};
				if (listWorkspacePatterns(parsed.workspaces).length > 0) {
					return current;
				}
			} catch {
				// Ignore invalid package metadata while walking upward.
			}
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

function shouldUseResolvedExtensionEntriesEnv(
	entries: ReturnType<typeof parseResolvedExtensionEntries>,
): boolean {
	if (entries.length === 0) return true;
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const explicitlyAllowedRoots = parseExtensionAllowedRoots(
		process.env[RUNTIME_EXTENSION_ALLOWED_ROOTS_ENV],
	);
	// Explicitly resolved extension entries from the server are authoritative,
	// but only when they still exist inside the worker's checkout or an explicit
	// local development composition root. Isolated workers do not receive the
	// development-only roots and continue to reject host checkout paths.
	return entriesExistWithinAllowedRoots({
		entries,
		allowedRoots: [...(workspaceRoot ? [workspaceRoot] : []), ...explicitlyAllowedRoots],
	});
}

async function loadRuntimeCatalog(): Promise<ExtensionCatalog> {
	const resolvedEntriesJson = process.env[RUNTIME_EXTENSION_ENTRIES_ENV];
	if (resolvedEntriesJson) {
		const entries = parseResolvedExtensionEntries(resolvedEntriesJson);
		if (shouldUseResolvedExtensionEntriesEnv(entries)) {
			const modules = await importExtensionModules(entries);
			return buildExtensionCatalog(modules);
		}
	}
	return buildExtensionCatalog([]);
}

function getRuntimeCatalog(): Promise<ExtensionCatalog> {
	runtimeCatalogPromise ??= loadRuntimeCatalog();
	return runtimeCatalogPromise;
}

export interface WorkerEntryRuntimeOverrides extends Partial<WorkerRuntimeConfig> {
	piFactory?: PiTreeHandleFactory;
	gitOps?: RunRootGitOps;
	transport?: WorkerIpc;
	sessionSnapshots?: WorkerSessionSnapshotExchange;
	resultImageTools?: WorkerRuntimeAdapters["resultImageTools"];
	scheduler?: WorkerRuntimeScheduler;
	stderr?: NodeJS.WritableStream;
	env?: NodeJS.ProcessEnv;
	exit?: (code: number) => void;
	extensionEvents?: WorkerRuntimeAdapters["extensionEvents"];
	resolveWorkerProcess?: WorkerRuntimeAdapters["resolveWorkerProcess"];
	extensionCatalog?: ExtensionCatalog | Promise<ExtensionCatalog>;
	workerExtensionApi?: WorkerExtensionAPI;
}

function resolveDefaultPiFactory(): PiTreeHandleFactory {
	return new SdkPiTreeHandleFactory();
}

export function createWorkerEntryRuntime(
	overrides: WorkerEntryRuntimeOverrides = {},
): WorkerRuntime {
	const capabilityAccessor = createCapabilityAccessor();
	const workerExtensionApi = overrides.workerExtensionApi ?? {
		events: overrides.extensionEvents ?? createEventBus(),
		get: capabilityAccessor.get,
		require: capabilityAccessor.require,
	};
	let catalogWithSetupPromise: Promise<ExtensionCatalog> | null = null;
	const getCatalogWithSetup = (): Promise<ExtensionCatalog> => {
		catalogWithSetupPromise ??= Promise.resolve(
			overrides.extensionCatalog ?? getRuntimeCatalog(),
		).then(async (catalog) => {
			await setupWorkerExtensions(catalog, workerExtensionApi);
			return catalog;
		});
		return catalogWithSetupPromise;
	};

	const runtimeEnv = { ...(overrides.env ?? process.env) };
	const instanceId = overrides.instanceId ?? runtimeEnv[WORKER_INSTANCE_ID_ENV];
	const workerId = overrides.workerId ?? runtimeEnv[WORKER_ID_ENV];
	if (!instanceId || !workerId) {
		throw new Error("Missing required worker identity env");
	}
	const transport =
		overrides.transport ??
		createWorkerIpcFromEnvironment({ env: runtimeEnv, instanceId, workerId });
	const sessionSnapshots =
		overrides.sessionSnapshots ??
		createWorkerSessionSnapshotExchangeFromEnv({ env: runtimeEnv, instanceId, workerId });
	const scheduler = overrides.scheduler ?? nodeWorkerRuntimeScheduler;
	const resultImageServerUrl = runtimeEnv[WORKER_IPC_SERVER_URL_ENV];
	const resultImageToken = runtimeEnv[WORKER_SNAPSHOT_TOKEN_ENV];
	const resultImageTools =
		overrides.resultImageTools ??
		({
			create(input) {
				if (!input.workspaceRoot || !resultImageServerUrl || !resultImageToken) return null;
				return createUploadResultImagesTool({
					...input,
					workspaceRoot: input.workspaceRoot,
					workerId,
					serverUrl: resultImageServerUrl,
					token: resultImageToken,
					maxSizeBytes: RESULT_IMAGE_MAX_SIZE_BYTES,
					sleepImpl: scheduler.sleep.bind(scheduler),
				});
			},
		} satisfies WorkerRuntimeAdapters["resultImageTools"]);
	for (const key of [
		WORKER_IPC_CONNECT_TOKEN_ENV,
		WORKER_IPC_RECONNECT_ENV,
		WORKER_SNAPSHOT_TOKEN_ENV,
	]) {
		delete process.env[key];
	}

	const resolveWorkerProcess = overrides.resolveWorkerProcess
		? overrides.resolveWorkerProcess
		: async (
				processId: string,
				opts?: { paramsJson?: string | null; stateJson?: string | null },
			) => {
				const catalog = await getCatalogWithSetup();
				return createCatalogWorkerDefinitionResolver(catalog)(processId, opts);
			};

	return createWorkerRuntime({
		config: {
			instanceId,
			workerId,
			heartbeatIntervalMs: overrides.heartbeatIntervalMs,
			turnMaxDurationMs: overrides.turnMaxDurationMs,
			turnInactivityTimeoutMs: overrides.turnInactivityTimeoutMs,
			turnAbortGracePeriodMs: overrides.turnAbortGracePeriodMs,
		},
		adapters: {
			transport,
			sessionSnapshots,
			resultImageTools,
			piFactory: overrides.piFactory ?? resolveDefaultPiFactory(),
			gitOps: overrides.gitOps ?? new NodeRunRootGitOps(),
			resolveWorkerProcess,
			extensionEvents: workerExtensionApi.events,
			stderr: overrides.stderr,
			scheduler,
			exit: overrides.exit ?? ((code) => process.exit(code)),
		},
	});
}
