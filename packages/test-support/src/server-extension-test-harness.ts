import { type ExtensionCatalog, setupServerExtensions } from "@leitwerk-dev/extension-runtime";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	bindExternalWrites,
	type ExternalWriteLogRepoLike,
} from "@leitwerk-dev/external-writes/internal";
import {
	type CoreServerSetupDeps,
	coreHostCapabilities,
	createCapabilityAccessor,
	createEventBus,
	type IntegrationToolDefinition,
	type LeitwerkExtensionModule,
	type ProvidedCapability,
	type ServerExtensionAPI,
	type ServerExtensionEventMap,
} from "@leitwerk-dev/process-sdk";
import { flushAsyncWork } from "@leitwerk-dev/worker-protocol";

export { flushAsyncWork };

/** Register a test provider and expose its poll result without erasing its type. @public */
export function createPollingTestExtension<T>(
	manifest: LeitwerkExtensionModule["manifest"],
	setup: (api: ServerExtensionAPI) =>
		| {
				/** @internal */
				poll(): Promise<T>;
		  }
		| undefined,
) {
	let provider: ReturnType<typeof setup>;
	return {
		/** @internal */
		manifest,
		/** @internal */
		setupServer(api: ServerExtensionAPI) {
			provider = setup(api);
		},
		/** @public */
		poll() {
			if (!provider) throw new Error(`Test provider '${manifest.id}' has not been initialized`);
			return provider.poll();
		},
	};
}

/** @internal */
export function createToolCollector(
	writes: ExternalWriteLogRepoLike = createInMemoryExternalWriteLog(),
) {
	const tools = new Map<string, IntegrationToolDefinition>();
	const api = {
		tool: (tool: IntegrationToolDefinition) =>
			tools.set(tool.name, {
				...tool,
				execute: (ctx, args) =>
					tool.execute(
						{ ...ctx, externalWrites: bindExternalWrites(writes, ctx.process.id) },
						args,
					),
			}),
	} as unknown as ServerExtensionAPI;
	return {
		/** @internal */
		api,
		/** @internal */
		tools,
	};
}

/** @internal */
export interface InMemoryExternalWriteLog {
	/** @internal */
	records: {
		/** @internal */
		dedupKey: string;
	}[];
	/** @internal */
	hasDedupKey(key: string): boolean;
	/** @internal */
	record(input: {
		/** @internal */
		dedupKey: string;
	}): {
		/** @internal */
		dedupKey: string;
	};
	/** @internal */
	getDedupKeys(): ReadonlySet<string>;
}

/** @internal */
export function createInMemoryExternalWriteLog(): InMemoryExternalWriteLog {
	const dedupKeys = new Set<string>();
	const records: { dedupKey: string }[] = [];
	return {
		records,
		hasDedupKey(key: string) {
			return dedupKeys.has(key);
		},
		record(input: { dedupKey: string }) {
			dedupKeys.add(input.dedupKey);
			records.push(input);
			return input;
		},
		getDedupKeys() {
			return dedupKeys;
		},
	};
}

function createDefaultServerSetupDeps(): CoreServerSetupDeps {
	return {
		serverBaseUrl: "https://leitwerk.example",
		components: {},
		externalWrites: createInMemoryExternalWriteLog(),
		polling: {
			create(options) {
				return { poll: options.pollOnce };
			},
		},
		repositoryCredentials: { register: () => {} },
		processes: {
			create: () => {
				throw new Error("not used");
			},
			getById: () => null,
			listAll: () => [],
			update: () => null,
		},
		projects: {
			create: () => {
				throw new Error("not used");
			},
			getByInstanceAndKey: () => null,
			update: () => null,
			listByInstance: () => [],
		},
		events: { create: () => {}, listByInstance: () => [] },
		broadcaster: { sendDurable: () => {} },
		commands: {
			getDeferredProcessActivationSnapshots: () => ({ outcome: "process_not_found" }),
			activateDeferredProcess: async () => ({
				ok: true,
				process: null,
				data: { outcome: "not_applicable" },
			}),
			parkDeferredProcessActivationFailure: async () => ({
				ok: true,
				process: null,
				data: { outcome: "parked" },
			}),
			startProcess: async () => ({ ok: true, process: null }),
			abortProcess: async () => ({ ok: true, process: null }),
			retryProcess: async () => ({ ok: true, process: null }),
			continueFailedTurn: async () => ({ ok: true, process: null }),
			queueInputs: async () => ({ ok: true, process: null }),
		},
		processActions: {
			listVisibleActions: () => [],
			executeAction: async () => ({ ok: true, process: null }),
		},
		externalSources: {
			listArmed: () => [],
			fire: async () => ({ ok: true, process: null }),
		},
		getSupervisor: () => undefined,
		launcherService: {
			listUiLaunchers: () => [],
			resolveUiDefaults: async () => ({}),
			resolveUiOptions: async () => ({}),
			resolveUiRelaunchInput: async (_launcherId, previousInput) => ({ ...previousInput }),
			resolveUiLauncher: async () => ({ ok: false as const, errors: [] }),
		},
		launcherRecentValues: {
			list: () => ({}),
			record: () => {},
		},
		launcherModelConfigs: {
			getSchema: async () => null,
			preview: async () => null,
		},
		launchPlans: {
			async prepare(launchPlan, opts) {
				return {
					ok: true as const,
					launchPlan,
					modelConfig: opts?.modelConfig ?? {},
					warnings: [],
				};
			},
		},
		launchRuns: {
			async startProgrammatic() {
				throw new Error("not used");
			},
			async startWatcher() {
				throw new Error("not used");
			},
		},
	};
}

/** @public */
export function createTestServerSetupCapability(
	overrides: Partial<CoreServerSetupDeps> = {},
): CoreServerSetupDeps {
	const defaults = createDefaultServerSetupDeps();
	return {
		...defaults,
		...overrides,
		processes: { ...defaults.processes, ...overrides.processes },
		projects: { ...defaults.projects, ...overrides.projects },
		events: { ...defaults.events, ...overrides.events },
		broadcaster: { ...defaults.broadcaster, ...overrides.broadcaster },
		commands: { ...defaults.commands, ...overrides.commands },
		processActions: { ...defaults.processActions, ...overrides.processActions },
		externalSources: { ...defaults.externalSources, ...overrides.externalSources },
		launcherService: { ...defaults.launcherService, ...overrides.launcherService },
		launcherRecentValues: {
			...defaults.launcherRecentValues,
			...overrides.launcherRecentValues,
		},
		launcherModelConfigs: {
			...defaults.launcherModelConfigs,
			...overrides.launcherModelConfigs,
		},
		launchPlans: { ...defaults.launchPlans, ...overrides.launchPlans },
		launchRuns: { ...defaults.launchRuns, ...overrides.launchRuns },
	};
}

/** @internal */
export interface ServerExtensionTestHarness {
	/** @internal */
	catalog: ExtensionCatalog;
	/** @internal */
	events: ReturnType<typeof createEventBus>;
	/** @internal */
	serverSetup: CoreServerSetupDeps;
	/** @internal */
	startHooks: Array<() => void | Promise<void>>;
	/** @internal */
	stopHooks: Array<() => void | Promise<void>>;
	/** @internal */
	flushAsyncWork: typeof flushAsyncWork;
}

/** @internal */
export async function setupServerExtensionTest(input: {
	/** @internal */
	modules: readonly LeitwerkExtensionModule[];
	/** @internal */
	providedCapabilities?: readonly ProvidedCapability[];
	/** @internal */
	serverSetup?: Partial<CoreServerSetupDeps>;
	/** @internal */
	onStart?: (handler: () => void | Promise<void>) => void;
	/** @internal */
	onStop?: (handler: () => void | Promise<void>) => void;
}): Promise<ServerExtensionTestHarness> {
	const catalog = await buildExtensionCatalogFromModules(input.modules);
	const events = createEventBus<ServerExtensionEventMap>();
	const serverSetup = createTestServerSetupCapability(input.serverSetup);
	const capabilities = createCapabilityAccessor([
		{
			token: coreHostCapabilities.serverSetup,
			value: serverSetup,
		},
		...(input.providedCapabilities ?? []),
	]);
	const startHooks: Array<() => void | Promise<void>> = [];
	const stopHooks: Array<() => void | Promise<void>> = [];

	await setupServerExtensions(catalog, {
		events,
		provide: capabilities.provide.bind(capabilities),
		get: capabilities.get.bind(capabilities),
		require: capabilities.require.bind(capabilities),
		tool() {},
		onStart(handler) {
			startHooks.push(handler);
			input.onStart?.(handler);
		},
		onStop(handler) {
			stopHooks.push(handler);
			input.onStop?.(handler);
		},
	});

	return {
		catalog,
		events,
		serverSetup,
		startHooks,
		stopHooks,
		flushAsyncWork,
	};
}
