import { randomUUID } from "node:crypto";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type {
	ExtensionProcessDefinition,
	LeitwerkExtensionModule,
	ProcessLaunchConfig,
} from "@leitwerk-dev/process-sdk";
import { type AppContext, createAppContext, type LeitwerkConfig } from "@leitwerk-dev/server";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import { createInProcessWorkerSpawn } from "@leitwerk-dev/test-support/worker-testing";
import { type PiTreeHandleFactory, SdkPiTreeHandleFactory } from "@leitwerk-dev/worker";
import { SANDBOX_MODEL_ID, SANDBOX_MODEL_PROVIDER } from "./config.js";

export { readSandboxSettings, sandboxConfig } from "./config.js";

/** Scripted model provider matching the profile configured by `sandboxConfig`. @public */
export const scriptedSandboxModel: LeitwerkExtensionModule = {
	manifest: { id: "sandbox-model", version: "1.0.0" },
	modelProviders: fixtureModelProviders({
		id: SANDBOX_MODEL_PROVIDER,
		modelId: SANDBOX_MODEL_ID,
		server: true,
	}),
};

/** Rejects a control request with an HTTP status instead of a server error. @public */
export class SandboxControlError extends Error {
	/** @public */
	readonly statusCode: number;
	/** @public */
	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "SandboxControlError";
		this.statusCode = statusCode;
	}
}

/** @public */
type SandboxMode = "scripted" | "real";
/** @public */
interface SandboxPaths {
	/** @public */
	workspaceRoot: string;
	/** @public */
	root: string;
	/** @public */
	directory: string;
}
/** @public */
interface SandboxUrls {
	/** @public */
	ui: string;
	/** @public */
	backend: string;
}
/** @public */
export interface SandboxInput {
	/** @public */
	paths: SandboxPaths;
	/** @public */
	mode: SandboxMode;
	/** @public */
	urls: SandboxUrls;
	/** @public */
	modelProfileId: string;
}
/** @public */
export interface SandboxScenario<T = unknown> {
	/** @public */
	name: string;
	/** @internal */
	description: string;
	/** Registers a `sandbox.<name>` launcher. Required unless `launcherId` is set. @internal */
	launch?(input: Record<string, unknown>, branch: string): ProcessLaunchConfig<T>;
	/** Admit through this existing launcher instead of a sandbox launcher. @internal */
	launcherId?: string;
	/**
	 * Returns launcher input. Replays repeat the request id and must reconcile earlier writes.
	 * @internal
	 */
	prepareLaunch?(
		requestId: string,
		input: Record<string, unknown>,
	): Promise<Record<string, unknown>>;
	/** @internal */
	startupDelays?: {
		/** @internal */
		connectMs: number;
		/** @internal */
		prepareMs: number;
	};
}

/** The composition owns adapters and persisted scenario progress. @public */
export interface SandboxComposition {
	/** @public */
	processConfigs: LeitwerkConfig["process_configs"];
	/** @public */
	development: {
		/** @public */
		extensions: string[];
		/** @public */
		watchPaths: string[];
	};
	/** @public */
	scenarios: readonly SandboxScenario[];
	/** @public */
	initialize?(): void | Promise<void>;
	/** @public */
	createCatalog(): Promise<ExtensionCatalog>;
	/** @public */
	scriptedPi(context: () => AppContext): PiTreeHandleFactory;
	/** @public */
	registerControls?(context: AppContext): void | Promise<void>;
	/** @public */
	controlState?(): Record<string, unknown>;
	/** @public */
	poll?(): Promise<unknown>;
	/** @internal */
	cleanup?(): void | Promise<void>;
}
/** @public */
export type SandboxCompositionFactory = (input: SandboxInput) => SandboxComposition;

const ownLaunchers = new WeakMap<object, ExtensionProcessDefinition<never, never>["launchers"]>();

/** @public */
export interface WithSandboxLaunchersOptions {
	/** `replace` hides the process's own launchers. Defaults to `keep`. @public */
	ownLaunchers?: "keep" | "replace";
}

/**
 * Add development launchers to an SDK-defined process, retaining its identity and, by
 * default, its own launchers. Repeated calls replace the previously installed scenarios.
 * @public
 */
export function withSandboxLaunchers<T, S>(
	definition: ExtensionProcessDefinition<T, S>,
	scenarios: readonly SandboxScenario<T>[],
	options: WithSandboxLaunchersOptions = {},
): ExtensionProcessDefinition<T, S> {
	type Launchers = ExtensionProcessDefinition<T, S>["launchers"];
	if (!ownLaunchers.has(definition))
		ownLaunchers.set(
			definition,
			definition.launchers as ExtensionProcessDefinition<never, never>["launchers"],
		);
	const own =
		options.ownLaunchers === "replace" ? undefined : (ownLaunchers.get(definition) as Launchers);
	return Object.assign(definition, {
		launchers(api: Parameters<NonNullable<Launchers>>[0]) {
			own?.call(definition, api);
			for (const scenario of scenarios) {
				const launch = scenario.launch;
				if (!launch) continue;
				api.launcher({
					id: `sandbox.${scenario.name}`,
					label: `Local: ${scenario.name}`,
					description: scenario.description,
					visibility: "ui",
					ui: {
						card: { title: `Local: ${scenario.name}`, description: scenario.description },
						launchConfigSchema: {
							id: `sandbox_${scenario.name}`,
							title: scenario.name,
							fields: [],
							submitLabel: "Start scenario",
						},
						resolveLaunchConfig(input) {
							return {
								ok: true,
								launchConfig: {
									...launch(input, `sandbox/${scenario.name}/${randomUUID().slice(0, 8)}`),
									startTurnId: definition.entryTurnId,
									externalId: `sandbox:${scenario.name}:${randomUUID()}`,
									title: `Local: ${scenario.name}`,
								},
							};
						},
					},
				});
			}
		},
	});
}

function assertScenarios(scenarios: readonly SandboxScenario[]): void {
	const names = new Set<string>();
	for (const scenario of scenarios) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(scenario.name))
			throw new Error(`Sandbox scenario name '${scenario.name}' must be lowercase kebab-case`);
		if (names.has(scenario.name)) throw new Error(`Duplicate sandbox scenario '${scenario.name}'`);
		names.add(scenario.name);
		if (!scenario.launch === !scenario.launcherId)
			throw new Error(
				`Sandbox scenario '${scenario.name}' needs exactly one of launch or launcherId`,
			);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The composition's `processConfigs` replace `config.process_configs`. @public */
export async function createSandboxApp(
	config: LeitwerkConfig,
	input: SandboxInput,
	factory: SandboxCompositionFactory,
) {
	if (config.server.host !== "127.0.0.1" || config.server.base_url !== input.urls.backend)
		throw new Error("Sandbox requires the configured loopback backend");
	for (const url of Object.values(input.urls)) {
		const parsed = new URL(url);
		if (parsed.hostname !== "127.0.0.1" || parsed.protocol !== "http:" || parsed.origin !== url)
			throw new Error("Sandbox URLs must be HTTP loopback origins");
	}
	const composition = factory(input);
	let context: AppContext | undefined;
	let stopped: Promise<void> | undefined;
	const stop = () =>
		(stopped ??= (async () => {
			try {
				await context?.close();
			} finally {
				await composition.cleanup?.();
			}
		})());
	try {
		assertScenarios(composition.scenarios);
		await composition.initialize?.();
		const extensionCatalog = await composition.createCatalog();
		context = await createAppContext({
			config: { ...config, process_configs: composition.processConfigs },
			extensionCatalog,
			...(input.mode === "scripted" ? { localWorkerDockerPreflightImpl: async () => {} } : {}),
			localWorkerSpawnImpl: createInProcessWorkerSpawn({
				extensionCatalog,
				startupDelays:
					input.mode === "real"
						? undefined
						: (id) => {
								const name = context?.deps.processes.getById(id)?.externalId?.split(":")[1];
								return composition.scenarios.find((scenario) => scenario.name === name)
									?.startupDelays;
							},
				piFactory:
					input.mode === "real"
						? new SdkPiTreeHandleFactory()
						: composition.scriptedPi(() => {
								if (!context) throw new Error("Sandbox is still initializing");
								return context;
							}),
			}),
		});
		const app = context.app;
		app.addHook("onRequest", async (request, reply) => {
			if (!request.url.startsWith("/__local")) return;
			const origin = request.headers.origin;
			if (
				(origin && origin !== input.urls.backend) ||
				request.headers["sec-fetch-site"] === "cross-site"
			)
				return reply.code(403).send({ error: "Open controls from the local backend URL." });
		});
		app.get("/__local/state", async () => ({
			...composition.controlState?.(),
			scenariosAvailable: composition.scenarios.map((s) => s.name),
			scenarioDescriptions: composition.scenarios.map(({ name, description }) => ({
				name,
				description,
			})),
			processes: context?.deps.processes.listAll(),
			uiUrl: input.urls.ui,
			backendUrl: input.urls.backend,
		}));
		app.post<{ Body: { name?: string; requestId?: string; input?: unknown } }>(
			"/__local/scenarios",
			async (request, reply) => {
				const { name, requestId, input: scenarioInput = {} } = request.body ?? {};
				const scenario = composition.scenarios.find((s) => s.name === name);
				if (!scenario || typeof requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId))
					return reply.code(400).send({ error: "A known scenario and request id are required" });
				if (!isRecord(scenarioInput))
					return reply.code(400).send({ error: "Scenario input must be an object" });
				let launcherInput: Record<string, unknown>;
				try {
					launcherInput = (await scenario.prepareLaunch?.(requestId, scenarioInput)) ?? {};
				} catch (error) {
					if (error instanceof SandboxControlError)
						return reply.code(error.statusCode).send({ error: error.message });
					throw error;
				}
				const launcherId = scenario.launcherId ?? `sandbox.${scenario.name}`;
				const admitted = await app.inject({
					method: "POST",
					url: `/api/launchers/${encodeURIComponent(launcherId)}/launch-runs`,
					headers: { "idempotency-key": requestId },
					payload: { launcherInput, schedule: { mode: "now" } },
				});
				return reply.code(admitted.statusCode).send(admitted.json());
			},
		);
		app.post("/__local/poll", async () => (await composition.poll?.()) ?? []);
		await composition.registerControls?.(context);
		return {
			/** @public */
			context,
			/** @public */
			composition,
			/** @public */
			stop,
			/** @public */
			poll: async () => (await composition.poll?.()) ?? [],
		};
	} catch (error) {
		await stop();
		throw error;
	}
}
