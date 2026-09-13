import { randomUUID } from "node:crypto";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type { ExtensionProcessDefinition, ProcessLaunchConfig } from "@leitwerk-dev/process-sdk";
import { type AppContext, createAppContext, type LeitwerkConfig } from "@leitwerk-dev/server";
import { createInProcessWorkerSpawn } from "@leitwerk-dev/test-support/worker-testing";
import { type PiTreeHandleFactory, SdkPiTreeHandleFactory } from "@leitwerk-dev/worker";

export type SandboxMode = "scripted" | "real";
export interface SandboxPaths {
	workspaceRoot: string;
	root: string;
	directory: string;
}
export interface SandboxUrls {
	ui: string;
	backend: string;
}
export interface SandboxInput {
	paths: SandboxPaths;
	mode: SandboxMode;
	urls: SandboxUrls;
	modelProfileId: string;
}
export interface SandboxScenario<T = unknown> {
	name: string;
	description: string;
	launch(input: Record<string, unknown>, branch: string): ProcessLaunchConfig<T>;
	prepareLaunch?(requestId: string): Promise<Record<string, unknown>>;
	startupDelays?: { connectMs: number; prepareMs: number };
}

/** The composition owns adapters and persisted scenario progress. */
export interface SandboxComposition {
	processConfigs: LeitwerkConfig["process_configs"];
	development: { extensions: string[]; watchPaths: string[] };
	scenarios: readonly SandboxScenario[];
	initialize?(): void | Promise<void>;
	createCatalog(): Promise<ExtensionCatalog>;
	scriptedPi(context: () => AppContext): PiTreeHandleFactory;
	registerControls?(context: AppContext): void | Promise<void>;
	controlState?(): Record<string, unknown>;
	poll?(): Promise<unknown>;
	cleanup?(): void | Promise<void>;
}
export type SandboxCompositionFactory = (input: SandboxInput) => SandboxComposition;

/** Install development launchers on an SDK-defined process, retaining its identity. */
export function withSandboxLaunchers<T, S>(
	definition: ExtensionProcessDefinition<T, S>,
	scenarios: readonly SandboxScenario<T>[],
): ExtensionProcessDefinition<T, S> {
	return Object.assign(definition, {
		launchers(api: Parameters<NonNullable<ExtensionProcessDefinition<T, S>["launchers"]>>[0]) {
			for (const scenario of scenarios)
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
									...scenario.launch(input, `sandbox/${scenario.name}/${randomUUID().slice(0, 8)}`),
									startTurnId: definition.entryTurnId,
									externalId: `sandbox:${scenario.name}:${randomUUID()}`,
									title: `Local: ${scenario.name}`,
								},
							};
						},
					},
				});
		},
	});
}

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
				await context?.stopBackgroundServices();
			} finally {
				try {
					await context?.app.close();
				} finally {
					await composition.cleanup?.();
				}
			}
		})());
	try {
		await composition.initialize?.();
		const extensionCatalog = await composition.createCatalog();
		context = await createAppContext({
			config,
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
		app.post<{ Body: { name: string; requestId: string } }>(
			"/__local/scenarios",
			async (request, reply) => {
				const { name, requestId } = request.body ?? {};
				const scenario = composition.scenarios.find((s) => s.name === name);
				if (!scenario || typeof requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId))
					return reply.code(400).send({ error: "A known scenario and request id are required" });
				const launcherInput = (await scenario.prepareLaunch?.(requestId)) ?? {};
				const admitted = await app.inject({
					method: "POST",
					url: `/api/launchers/sandbox.${name}/launch-runs`,
					headers: { "idempotency-key": requestId },
					payload: { launcherInput, schedule: { mode: "now" } },
				});
				return reply.code(admitted.statusCode).send(admitted.json());
			},
		);
		app.post("/__local/poll", async () => (await composition.poll?.()) ?? []);
		await composition.registerControls?.(context);
		return { context, composition, stop, poll: async () => (await composition.poll?.()) ?? [] };
	} catch (error) {
		await stop();
		throw error;
	}
}
