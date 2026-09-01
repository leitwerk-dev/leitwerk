import type { spawn } from "node:child_process";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	type Codec,
	defineModelProvider,
	defineModelProviders,
	defineProcess,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { parseFutureLaunchPayloadJson, serializeFutureLaunchPayload } from "@leitwerk-dev/protocol";
import { createAppContext, getDefaultConfig } from "@leitwerk-dev/server";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_PROCESS_TITLE_LENGTH } from "./launch-title.js";

function parseFutureLaunchPayloadOrThrow(payloadJson: string) {
	const parsed = parseFutureLaunchPayloadJson(payloadJson);
	if (!parsed.ok) {
		throw new Error(parsed.error);
	}
	return parsed.value;
}

interface LauncherTestParams {
	repoPath: string;
	baseBranch: string;
	prompt: string;
}

interface LauncherTestState {
	launchedFrom: string;
}

const launcherPlanTurn = {
	id: "launcher_plan_turn",
	description: "Launcher setup turn",
	availableTools: [],
	kind: "llm" as const,
	completionMode: "turn_end" as const,
	branchType: "primary" as const,
	context: "fresh" as const,
	prompt: async () => "Plan the work",
	outcomes: {},
	turnEnd: { outcome: "completed" as const, params: {}, complete: true },
};

const launcherTestParamsCodec: Codec<LauncherTestParams> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		return {
			repoPath:
				typeof (record as { repoPath?: unknown }).repoPath === "string"
					? (record as { repoPath: string }).repoPath
					: "",
			baseBranch:
				typeof (record as { baseBranch?: unknown }).baseBranch === "string"
					? (record as { baseBranch: string }).baseBranch
					: "main",
			prompt:
				typeof (record as { prompt?: unknown }).prompt === "string"
					? (record as { prompt: string }).prompt
					: "",
		};
	},
	serialize(value) {
		return value;
	},
};

const launcherTestStateCodec: Codec<LauncherTestState> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		return {
			launchedFrom:
				typeof (record as { launchedFrom?: unknown }).launchedFrom === "string"
					? (record as { launchedFrom: string }).launchedFrom
					: "",
		};
	},
	serialize(value) {
		return value;
	},
};

const launcherTestProcess = defineProcess<LauncherTestParams, LauncherTestState>({
	id: "launcher_test_process",
	displayName: "Launcher Test Process",
	entry: launcherPlanTurn.id,
	turns: { [launcherPlanTurn.id]: launcherPlanTurn },
	paramsCodec: launcherTestParamsCodec,
	stateCodec: launcherTestStateCodec,
	initialState(params) {
		return { launchedFrom: params.repoPath };
	},
	worker(api) {
		api.start("launcher_plan_turn");
		api.turn("launcher_plan_turn", async () => {});
	},
	launchers(api) {
		api.launcher({
			id: "launcher_test_process.local_repo_ui",
			label: "Local Repo Flow",
			description: "Launch from a local repository",
			visibility: "ui",
			ui: {
				card: {},
				launchConfigSchema: {
					id: "local_repo_flow_form",
					title: "Local Repo Flow",
					fields: [
						{
							id: "repoPath",
							label: "Repo",
							kind: "text",
							required: true,
							rememberRecentValues: true,
						},
						{ id: "prompt", label: "Prompt", kind: "textarea", required: true },
						{ id: "baseBranch", label: "Base Branch", kind: "text" },
						{ id: "startNow", label: "Start Now", kind: "boolean" },
					],
					submitLabel: "Launch",
				},
				resolveDefaults() {
					return { repoPath: "/tmp/project", baseBranch: "main", prompt: "Ship it" };
				},
				resolveOptions(input) {
					const baseBranch =
						typeof input.baseBranch === "string" && input.baseBranch.trim() !== ""
							? input.baseBranch
							: "main";
					return {
						baseBranch: [
							{ value: baseBranch, label: `Use ${baseBranch}` },
							{ value: "develop", label: "Use develop" },
						],
					};
				},
				resolveLaunchConfig(input) {
					const repoPath = typeof input.repoPath === "string" ? input.repoPath.trim() : "";
					const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
					if (!repoPath) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
						};
					}
					if (!prompt) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "prompt", message: "prompt is required" }],
						};
					}
					const baseBranch =
						typeof input.baseBranch === "string" && input.baseBranch.trim() !== ""
							? input.baseBranch.trim()
							: "main";
					return {
						ok: true,
						launchConfig: {
							processId: "launcher_test_process",
							params: { repoPath, baseBranch, prompt },
							titleSourceFields: [{ label: "Prompt", value: prompt }],
							metadata: { requestedBy: "integration-test" },
							...(typeof input.initialModelProfileId === "string" &&
							input.initialModelProfileId.trim() !== ""
								? { defaultModelProfileId: input.initialModelProfileId.trim() }
								: {}),
							...(input.startNow === true ? { startTurnId: "launcher_plan_turn" as const } : {}),
							projects: [
								{
									key: "repo",
									repoLocator: repoPath,
									baseBranch,
									workBranch: "feature/test",
									externalId: "42",
									externalUrl: "https://example.invalid/repos/42",
									metadata: { source: "ui" },
								},
							],
						},
					};
				},
			},
		});
		api.launcher({
			id: "launcher_test_process.partial_defaults_ui",
			label: "Partial Defaults Flow",
			description: "Launch from a form that starts with intentionally blank required fields",
			visibility: "ui",
			ui: {
				card: {},
				launchConfigSchema: {
					id: "partial_defaults_flow_form",
					title: "Partial Defaults Flow",
					fields: [
						{ id: "repoPath", label: "Repo", kind: "text", required: true },
						{ id: "prompt", label: "Prompt", kind: "textarea", required: true },
					],
					submitLabel: "Launch",
				},
				resolveDefaults() {
					return { repoPath: "", prompt: "" };
				},
				resolveLaunchConfig(input) {
					const repoPath = typeof input.repoPath === "string" ? input.repoPath.trim() : "";
					const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
					if (!repoPath) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
						};
					}
					if (!prompt) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "prompt", message: "prompt is required" }],
						};
					}
					return {
						ok: true,
						launchConfig: {
							processId: "launcher_test_process",
							params: { repoPath, baseBranch: "main", prompt },
							titleSourceFields: [{ label: "Prompt", value: prompt }],
						},
					};
				},
			},
		});
		api.launcher({
			id: "launcher_test_process.prefilled_model_ui",
			label: "Prefilled Model Flow",
			description: "Launch with a prefilled instance model config",
			visibility: "ui",
			ui: {
				card: {},
				launchConfigSchema: {
					id: "prefilled_model_flow_form",
					title: "Prefilled Model Flow",
					fields: [
						{ id: "repoPath", label: "Repo", kind: "text", required: true },
						{ id: "prompt", label: "Prompt", kind: "textarea", required: true },
						{ id: "baseBranch", label: "Base Branch", kind: "text" },
					],
					submitLabel: "Launch",
				},
				resolveDefaults() {
					return { repoPath: "/tmp/prefilled-model", baseBranch: "main", prompt: "Ship it" };
				},
				resolveLaunchConfig(input) {
					const repoPath = typeof input.repoPath === "string" ? input.repoPath.trim() : "";
					const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
					if (!repoPath) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
						};
					}
					if (!prompt) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "prompt", message: "prompt is required" }],
						};
					}
					const baseBranch =
						typeof input.baseBranch === "string" && input.baseBranch.trim() !== ""
							? input.baseBranch.trim()
							: "main";
					return {
						ok: true,
						launchConfig: {
							processId: "launcher_test_process",
							params: { repoPath, baseBranch, prompt },
							titleSourceFields: [{ label: "Prompt", value: prompt }],
							defaultModelProfileId: "local_qwen",
							turnConfigs: {
								launcher_plan_turn: { modelProfileId: "claude_fast" },
							},
						},
					};
				},
			},
		});
	},
});

const launcherTestExtension: LeitwerkExtensionModule = {
	manifest: { id: "launcher-http-test", version: "0.1.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "anthropic",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("anthropic"),
				models: () => [{ modelId: "claude-fast", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
		{
			definition: defineModelProvider({
				id: "ollama",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("ollama"),
				models: () => [{ modelId: "local-qwen", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
	setupCatalog(api) {
		api.registerProcess(launcherTestProcess);
	},
};

function applyLauncherModelConfig(config: ReturnType<typeof getDefaultConfig>) {
	config.pi.model_profiles = [
		{
			id: "claude_fast",
			provider: "anthropic",
			model_id: "claude-fast",
			thinking_level: "medium",
		},
		{
			id: "local_qwen",
			provider: "ollama",
			model_id: "local-qwen",
			thinking_level: "low",
		},
	];
}

const fixedModelTurn = {
	id: "fixed_model_turn",
	description: "Fixed model turn",
	availableTools: [],
	kind: "llm" as const,
	completionMode: "turn_end" as const,
	branchType: "primary" as const,
	context: "fresh" as const,
	prompt: async () => "Plan the work",
	outcomes: {},
	turnEnd: { outcome: "completed" as const, params: {}, complete: true },
};

const fixedModelLauncherProcess = defineProcess<LauncherTestParams, LauncherTestState>({
	id: "fixed_model_launcher_process",
	displayName: "Fixed Model Launcher Process",
	entry: fixedModelTurn.id,
	turns: { [fixedModelTurn.id]: fixedModelTurn },
	paramsCodec: launcherTestParamsCodec,
	stateCodec: launcherTestStateCodec,
	initialState(params) {
		return { launchedFrom: params.repoPath };
	},
	worker(api) {
		api.start("fixed_model_turn");
		api.turn("fixed_model_turn", async () => {});
	},
	launchers(api) {
		api.launcher({
			id: "fixed_model_launcher_process.local_repo_ui",
			label: "Fixed Model Flow",
			description: "Launch into a process with a fixed turn model",
			visibility: "ui",
			ui: {
				card: {},
				launchConfigSchema: {
					id: "fixed_model_flow_form",
					title: "Fixed Model Flow",
					fields: [
						{ id: "repoPath", label: "Repo", kind: "text", required: true },
						{ id: "prompt", label: "Prompt", kind: "textarea", required: true },
					],
					submitLabel: "Launch",
				},
				resolveLaunchConfig(input) {
					const repoPath = typeof input.repoPath === "string" ? input.repoPath.trim() : "";
					const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
					if (!repoPath) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "repoPath", message: "repoPath is required" }],
						};
					}
					if (!prompt) {
						return {
							ok: false,
							errors: [{ code: "required", fieldId: "prompt", message: "prompt is required" }],
						};
					}
					return {
						ok: true,
						launchConfig: {
							processId: "fixed_model_launcher_process",
							params: { repoPath, baseBranch: "main", prompt },
							titleSourceFields: [{ label: "Prompt", value: prompt }],
							startTurnId: "fixed_model_turn",
						},
					};
				},
			},
		});
	},
});

const fixedModelLauncherExtension: LeitwerkExtensionModule = {
	manifest: { id: "launcher-http-fixed-model-test", version: "0.1.0" },
	setupCatalog(api) {
		api.registerProcess(fixedModelLauncherProcess);
	},
};

let harness: IntegrationHarness;

async function waitFor<T>(
	read: () => T,
	predicate: (value: T) => boolean,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = read();
		if (predicate(value)) {
			return value;
		}
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for launcher condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function futureIso(minutesAhead = 24 * 60): string {
	return new Date(Date.now() + minutesAhead * 60_000).toISOString();
}

async function createTitleTestHarness(
	titleOrResolver:
		| string
		| ((launchPlan: { titleSourceFields?: readonly { label: string; value: string }[] }) => string),
) {
	const resolveTitle =
		typeof titleOrResolver === "function" ? titleOrResolver : () => titleOrResolver;
	const queueCounts = {
		process: 0,
		future: 0,
	};
	const shouldQueueTitleGeneration = (launchPlan: {
		processInput: { title?: string | null };
		titleSourceFields?: readonly { label: string; value: string }[];
	}) =>
		(!launchPlan.processInput.title || launchPlan.processInput.title.trim() === "") &&
		(launchPlan.titleSourceFields?.length ?? 0) > 0;
	let ctx: Awaited<ReturnType<typeof createAppContext>> | null = null;
	const config = getDefaultConfig();
	applyLauncherModelConfig(config);
	ctx = await createAppContext({
		logger: false,
		config,
		extensionCatalog: buildExtensionCatalogFromModules([launcherTestExtension]),
		processTitleGenerator: {
			queueProcessTitleGeneration({ processId, launchPlan }) {
				if (!shouldQueueTitleGeneration(launchPlan)) {
					return;
				}
				queueCounts.process += 1;
				const handle = setImmediate(() => {
					ctx?.deps.processes.update(processId, { title: resolveTitle(launchPlan) });
				});
				handle.unref?.();
			},
			queueFutureExecutionTitleGeneration({ futureExecutionId, launchPlan, expectedPayloadJson }) {
				if (!shouldQueueTitleGeneration(launchPlan)) {
					return;
				}
				queueCounts.future += 1;
				const handle = setImmediate(() => {
					const current = ctx?.deps.futureExecutions.getById(futureExecutionId);
					const title = resolveTitle(launchPlan);
					if (
						!current ||
						(expectedPayloadJson !== undefined && current.payloadJson !== expectedPayloadJson)
					) {
						return;
					}
					const payload = parseFutureLaunchPayloadOrThrow(current.payloadJson);
					ctx?.deps.futureExecutions.update(futureExecutionId, {
						payloadJson: serializeFutureLaunchPayload({
							...payload,
							launchPlan: {
								...payload.launchPlan,
								processInput: {
									...payload.launchPlan.processInput,
									title,
								},
							},
						}),
					});
				});
				handle.unref?.();
			},
		},
	});
	await ctx.app.listen({ host: "127.0.0.1", port: 0 });
	const info = ctx.app.server.address();
	const port = typeof info === "object" && info ? info.port : 0;
	return {
		ctx,
		address: `http://127.0.0.1:${port}`,
		getQueueCounts() {
			return { ...queueCounts };
		},
		async close() {
			await ctx?.app.close();
		},
	};
}

beforeAll(async () => {
	harness = await createIntegrationHarness({
		extensionCatalog: buildExtensionCatalogFromModules([launcherTestExtension]),
		inProcessWorkers: false,
		configOverride: applyLauncherModelConfig,
	});
});

afterAll(async () => {
	await harness.ctx.app.close();
});

describe("launcher HTTP routes", () => {
	it("lists UI-visible launchers with model-config schema metadata", async () => {
		const response = await fetch(`${harness.address}/api/launchers`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.launchers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "launcher_test_process.local_repo_ui",
					processId: "launcher_test_process",
					label: "Local Repo Flow",
					launchConfigSchema: expect.objectContaining({
						fields: expect.arrayContaining([
							expect.objectContaining({
								id: "repoPath",
								rememberRecentValues: true,
							}),
						]),
					}),
					modelConfigSchema: {
						availableProfiles: [
							expect.objectContaining({ id: "claude_fast", availability: "available" }),
							expect.objectContaining({ id: "local_qwen", availability: "available" }),
						],
						llmTurns: [{ turnId: "launcher_plan_turn", description: "Launcher setup turn" }],
					},
				}),
				expect.objectContaining({
					id: "launcher_test_process.prefilled_model_ui",
					processId: "launcher_test_process",
					label: "Prefilled Model Flow",
				}),
			]),
		);
	});

	it("resolves launcher defaults and options", async () => {
		const defaultsResponse = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/defaults`,
		);
		const defaultsBody = await defaultsResponse.json();
		expect(defaultsResponse.status).toBe(200);
		expect(defaultsBody.defaults).toEqual({
			repoPath: "/tmp/project",
			baseBranch: "main",
			prompt: "Ship it",
		});

		const optionsResponse = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/options`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ launcherInput: { baseBranch: "release" } }),
			},
		);
		const optionsBody = await optionsResponse.json();
		expect(optionsResponse.status).toBe(200);
		expect(optionsBody.options).toEqual({
			baseBranch: [
				{ value: "release", label: "Use release" },
				{ value: "develop", label: "Use develop" },
			],
		});
	});

	it("does not surface field-validation warnings for incomplete launcher defaults", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.partial_defaults_ui/defaults`,
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.defaults).toEqual({ repoPath: "", prompt: "" });
		expect(body.warnings).toBeUndefined();
	});

	it("prefills launcher-provided model config in launcher defaults", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.prefilled_model_ui/defaults`,
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.defaults).toEqual({
			repoPath: "/tmp/prefilled-model",
			baseBranch: "main",
			prompt: "Ship it",
		});
		expect(body.modelConfig).toEqual({
			defaultModelProfileId: "local_qwen",
			turnConfigs: {
				launcher_plan_turn: { modelProfileId: "claude_fast" },
			},
		});
	});

	it("sanitizes launcher-prefilled defaults that violate the process allowlist and returns warnings", async () => {
		const restrictedHarness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([launcherTestExtension]),
			inProcessWorkers: false,
			configOverride(config) {
				applyLauncherModelConfig(config);
				config.process_configs = {
					launcher_test_process: {
						allowed_model_profiles: ["local_qwen"],
						turn_configs: {},
					},
				};
			},
		});

		try {
			const response = await fetch(
				`${restrictedHarness.address}/api/launchers/launcher_test_process.prefilled_model_ui/defaults`,
			);
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body.modelConfig).toEqual({
				defaultModelProfileId: "local_qwen",
				turnConfigs: {},
			});
			expect(body.warnings).toEqual([
				expect.objectContaining({
					code: "invalid_model_config",
					message:
						"Model profile 'claude_fast' is not allowed for process 'launcher_test_process' (turn 'launcher_plan_turn')",
				}),
			]);
		} finally {
			await restrictedHarness.ctx.app.close();
		}
	});

	it("lets launch requests clear a prefilled launcher model config", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.prefilled_model_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/prefilled-model",
						baseBranch: "main",
						prompt: "Ship it",
					},
					modelConfig: {},
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.process).toMatchObject({
			defaultModelProfileId: null,
			turnConfigsJson: null,
		});
	});

	it("builds a model preview from launcher input, config defaults, and turn selectors", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/model-config-preview`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/project",
						baseBranch: "main",
						prompt: "Ship it",
					},
					modelConfig: {},
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.preview).toMatchObject({
			defaultModel: {
				source: "catalog_default",
				profile: { id: "claude_fast" },
			},
			turns: [
				{
					turnId: "launcher_plan_turn",
					effective: {
						source: "catalog_default",
						profile: { id: "claude_fast" },
					},
				},
			],
		});
	});

	it("previews the launcher-input-derived model used by the actual launch", async () => {
		const request = {
			launcherInput: {
				repoPath: "/tmp/repo",
				baseBranch: "main",
				prompt: "Ship it",
				initialModelProfileId: "local_qwen",
			},
		};
		const previewResponse = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/model-config-preview`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
			},
		);
		const previewBody = await previewResponse.json();

		expect(previewResponse.status).toBe(200);
		expect(previewBody.preview.defaultModel).toMatchObject({
			source: "instance_default",
			profile: { id: "local_qwen" },
		});

		const launchResponse = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(request),
			},
		);
		const launchBody = await launchResponse.json();
		expect(launchResponse.status).toBe(201);
		expect(launchBody.process.defaultModelProfileId).toBe("local_qwen");
	});

	it("uses process-config defaults and turn settings in the model preview", async () => {
		const configuredHarness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([launcherTestExtension]),
			inProcessWorkers: false,
			configOverride(config) {
				applyLauncherModelConfig(config);
				config.process_configs = {
					launcher_test_process: {
						default_model_profile: "claude_fast",
						turn_configs: {
							launcher_plan_turn: { model_profile: "local_qwen" },
						},
					},
				};
			},
		});

		try {
			const response = await fetch(
				`${configuredHarness.address}/api/launchers/launcher_test_process.local_repo_ui/model-config-preview`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/project",
							baseBranch: "main",
							prompt: "Ship it",
						},
						modelConfig: {},
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body.preview).toMatchObject({
				defaultModel: {
					source: "process_config_default",
					profile: { id: "claude_fast" },
				},
				turns: [
					{
						turnId: "launcher_plan_turn",
						effective: {
							source: "process_config_turn",
							profile: { id: "local_qwen" },
						},
					},
				],
			});
		} finally {
			await configuredHarness.ctx.app.close();
		}
	});

	it("treats selected launch-time defaults as instance-level preview inputs", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/model-config-preview`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/project",
						baseBranch: "main",
						prompt: "Ship it",
					},
					modelConfig: {
						defaultModelProfileId: "local_qwen",
						turnConfigs: {
							launcher_plan_turn: { modelProfileId: "claude_fast" },
						},
					},
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.preview).toMatchObject({
			defaultModel: {
				source: "instance_default",
				profile: { id: "local_qwen" },
			},
			turns: [
				{
					turnId: "launcher_plan_turn",
					effective: {
						source: "instance_turn_config",
						profile: { id: "claude_fast" },
					},
				},
			],
		});
	});

	it("rejects invalid model-config preview requests", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/model-config-preview`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/project",
						baseBranch: "main",
						prompt: "Ship it",
					},
					modelConfig: { defaultModelProfileId: "missing-model" },
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.errors).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "invalid_model_config" })]),
		);
	});

	it("returns 404 for unknown launcher ids", async () => {
		const response = await fetch(`${harness.address}/api/launchers/unknown-launcher/defaults`);
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body).toEqual({ error: "Launcher not found" });
	});

	it("returns 400 for non-object launcher options input", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/options`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify("hello"),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body).toEqual({ error: "launcher request body must be an object" });
	});

	it("rejects mixed flat and wrapped launcher request bodies", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					prompt: "Ship it",
					modelConfig: { defaultModelProfileId: "claude_fast" },
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.error).toContain("launcher request body must use");
	});

	it("returns structured validation errors for invalid launch input", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ launcherInput: { prompt: "Ship it" } }),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.errors).toEqual([
			{ code: "required", fieldId: "repoPath", message: "repoPath is required" },
		]);
	});

	it("rejects launcher-resolved model defaults outside the process allowlist", async () => {
		const restrictedHarness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([launcherTestExtension]),
			inProcessWorkers: false,
			configOverride(config) {
				applyLauncherModelConfig(config);
				config.process_configs = {
					launcher_test_process: {
						allowed_model_profiles: ["local_qwen"],
						turn_configs: {},
					},
				};
			},
		});

		try {
			const response = await fetch(
				`${restrictedHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/repo-restricted",
							prompt: "Use restricted model",
							initialModelProfileId: "claude_fast",
						},
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(400);
			expect(body.errors).toHaveLength(1);
			expect(body.errors[0]).toMatchObject({ code: "invalid_model_config" });
			expect(body.errors[0].message).toContain("not allowed for process 'launcher_test_process'");
		} finally {
			await restrictedHarness.ctx.app.close();
		}
	});

	it("rejects disallowed turn-definition models before persisting a started process", async () => {
		const restrictedHarness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([
				fixedModelLauncherExtension,
				launcherTestExtension,
			]),
			inProcessWorkers: false,
			configOverride(config) {
				applyLauncherModelConfig(config);
				config.process_configs = {
					fixed_model_launcher_process: {
						allowed_model_profiles: ["local_qwen"],
						turn_configs: {},
					},
				};
			},
		});

		try {
			const response = await fetch(
				`${restrictedHarness.address}/api/launchers/fixed_model_launcher_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/fixed-model-repo",
							prompt: "Validate fixed model selection",
						},
						modelConfig: {
							turnConfigs: {
								fixed_model_turn: { modelProfileId: "claude_fast" },
							},
						},
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(400);
			expect(body.errors).toEqual([
				expect.objectContaining({
					code: "invalid_model_config",
					message:
						"Model profile 'claude_fast' is not allowed for process 'fixed_model_launcher_process' (turn 'fixed_model_turn')",
				}),
			]);
			expect(restrictedHarness.ctx.deps.processes.listAll()).toEqual([]);
		} finally {
			await restrictedHarness.ctx.app.close();
		}
	});

	it("creates a process instance and projects from a resolved launcher", async () => {
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/repo",
						prompt: "Implement the change",
						baseBranch: "develop",
					},
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.process).toMatchObject({
			processId: "launcher_test_process",
			lifecycleStatus: "discovered",
			metadata: {
				requestedBy: "integration-test",
				launcherId: "launcher_test_process.local_repo_ui",
			},
		});
		expect(body.projects).toEqual([
			expect.objectContaining({
				key: "repo",
				repoLocator: "/tmp/repo",
				baseBranch: "develop",
				workBranch: "feature/test",
				externalId: "42",
				externalUrl: "https://example.invalid/repos/42",
				metadata: expect.objectContaining({ source: "ui" }),
			}),
		]);

		const persistedProcess = harness.ctx.deps.processes.getById(body.process.id);
		const persistedProjects = harness.ctx.deps.projects.listByInstance(body.process.id);
		expect(persistedProcess?.paramsJson).toBe(
			JSON.stringify({
				repoPath: "/tmp/repo",
				baseBranch: "develop",
				prompt: "Implement the change",
			}),
		);
		expect(persistedProcess?.stateJson).toBe(JSON.stringify({ launchedFrom: "/tmp/repo" }));
		expect(persistedProjects).toHaveLength(1);
		expect(persistedProjects[0]?.metadata).toEqual(expect.objectContaining({ source: "ui" }));

		const detailResponse = await fetch(`${harness.address}/api/processes/${body.process.id}`);
		const detailBody = await detailResponse.json();
		expect(detailResponse.status).toBe(200);
		expect(detailBody.launchConfiguration).toMatchObject({
			launcherId: "launcher_test_process.local_repo_ui",
			launcherLabel: "Local Repo Flow",
			launcherSchemaTitle: "Local Repo Flow",
			paramsParseError: null,
			parameters: [
				{ fieldId: "repoPath", label: "Repo", value: "/tmp/repo" },
				{ fieldId: "prompt", label: "Prompt", value: "Implement the change" },
				{ fieldId: "baseBranch", label: "Base Branch", value: "develop" },
			],
			projects: [
				{
					key: "repo",
					repoLocator: "/tmp/repo",
					repoLocatorKind: "local_path",
					baseBranch: "develop",
					workBranch: "feature/test",
					externalId: "42",
					externalUrl: "https://example.invalid/repos/42",
					pipelineStatus: null,
				},
			],
		});

		const recentsResponse = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/recent-values`,
		);
		const recentsBody = await recentsResponse.json();
		expect(recentsResponse.status).toBe(200);
		expect(recentsBody.values).toEqual({ repoPath: ["/tmp/repo"] });
	});

	it("persists a generated process title for immediate launches", async () => {
		const titledHarness = await createTitleTestHarness("Generated immediate title");
		try {
			const response = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/repo",
							baseBranch: "develop",
							prompt: "Implement the change",
						},
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(201);
			expect(body.process.title).toBeNull();
			await waitFor(
				() => titledHarness.ctx.deps.processes.getById(body.process.id)?.title,
				(value) => value === "Generated immediate title",
			);
		} finally {
			await titledHarness.close();
		}
	});

	it("keeps an explicitly submitted process title for immediate launches and skips title generation", async () => {
		const titledHarness = await createTitleTestHarness("Generated immediate title");
		try {
			const response = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title: "Explicit launch title",
						launcherInput: {
							repoPath: "/tmp/repo",
							baseBranch: "develop",
							prompt: "Implement the change",
						},
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(201);
			expect(body.process.title).toBe("Explicit launch title");
			expect(titledHarness.getQueueCounts().process).toBe(0);
		} finally {
			await titledHarness.close();
		}
	});

	it("normalizes explicitly submitted process titles before persistence", async () => {
		const titledHarness = await createTitleTestHarness("Generated immediate title");
		try {
			const response = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title: "  Explicit\n launch title  ",
						launcherInput: {
							repoPath: "/tmp/repo",
							baseBranch: "develop",
							prompt: "Implement the change",
						},
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(201);
			expect(body.process.title).toBe("Explicit launch title");
			expect(titledHarness.getQueueCounts().process).toBe(0);
		} finally {
			await titledHarness.close();
		}
	});

	it("returns the submitted title in retry config for launched UI processes", async () => {
		const titledHarness = await createTitleTestHarness("Generated retry title");
		try {
			const launchResponse = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title: "Retry this title",
						launcherInput: {
							repoPath: "/tmp/retry-repo",
							baseBranch: "develop",
							prompt: "Implement the change",
						},
					}),
				},
			);
			const launchBody = await launchResponse.json();
			expect(launchResponse.status).toBe(201);

			const retryResponse = await fetch(
				`${titledHarness.address}/api/processes/${launchBody.process.id}/retry-config`,
			);
			const retryBody = await retryResponse.json();

			expect(retryResponse.status).toBe(200);
			expect(retryBody).toMatchObject({
				launcherId: "launcher_test_process.local_repo_ui",
				title: "Retry this title",
				launcherInput: {
					repoPath: "/tmp/retry-repo",
					baseBranch: "develop",
					prompt: "Implement the change",
				},
			});
		} finally {
			await titledHarness.close();
		}
	});

	it("stores the generated process title on scheduled launches", async () => {
		const titledHarness = await createTitleTestHarness("Generated scheduled title");
		try {
			const runAt = futureIso();
			const response = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/scheduled-repo",
							prompt: "Implement later",
						},
						schedule: {
							mode: "once",
							runAt,
						},
					}),
				},
			);
			const body = await response.json();
			const storedExecution = titledHarness.ctx.deps.futureExecutions.getById(
				body.futureExecution.id,
			);

			expect(response.status).toBe(201);
			expect(body.futureExecution.title).toBe("Local Repo Flow");
			expect(storedExecution).not.toBeNull();
			await waitFor(
				() => {
					const updated = titledHarness.ctx.deps.futureExecutions.getById(body.futureExecution.id);
					return updated
						? parseFutureLaunchPayloadOrThrow(updated.payloadJson).launchPlan.processInput.title
						: null;
				},
				(value) => value === "Generated scheduled title",
			);
		} finally {
			await titledHarness.close();
		}
	});

	it("keeps an explicitly submitted process title for scheduled launches and skips title generation", async () => {
		const titledHarness = await createTitleTestHarness("Generated scheduled title");
		try {
			const runAt = futureIso();
			const response = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title: "Explicit scheduled title",
						launcherInput: {
							repoPath: "/tmp/scheduled-repo",
							prompt: "Implement later",
						},
						schedule: {
							mode: "once",
							runAt,
						},
					}),
				},
			);
			const body = await response.json();
			const storedExecution = titledHarness.ctx.deps.futureExecutions.getById(
				body.futureExecution.id,
			);

			expect(response.status).toBe(201);
			expect(body.futureExecution.title).toBe("Explicit scheduled title");
			expect(body.futureExecution.launchTitle).toBe("Explicit scheduled title");
			expect(
				storedExecution
					? parseFutureLaunchPayloadOrThrow(storedExecution.payloadJson).launchPlan.processInput
							.title
					: null,
			).toBe("Explicit scheduled title");
			expect(titledHarness.getQueueCounts().future).toBe(0);
		} finally {
			await titledHarness.close();
		}
	});

	it("caps explicitly submitted scheduled titles before storing the future execution", async () => {
		const titledHarness = await createTitleTestHarness("Generated scheduled title");
		try {
			const runAt = futureIso();
			const response = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title:
							"Explicit scheduled title that keeps rambling far beyond what should be shown to operators in compact list views",
						launcherInput: {
							repoPath: "/tmp/scheduled-repo",
							prompt: "Implement later",
						},
						schedule: {
							mode: "once",
							runAt,
						},
					}),
				},
			);
			const body = await response.json();
			const storedExecution = titledHarness.ctx.deps.futureExecutions.getById(
				body.futureExecution.id,
			);
			const storedTitle = storedExecution
				? parseFutureLaunchPayloadOrThrow(storedExecution.payloadJson).launchPlan.processInput.title
				: null;

			expect(response.status).toBe(201);
			expect(body.futureExecution.launchTitle?.length).toBeLessThanOrEqual(
				MAX_PROCESS_TITLE_LENGTH,
			);
			expect(storedTitle?.length).toBeLessThanOrEqual(MAX_PROCESS_TITLE_LENGTH);
			expect(titledHarness.getQueueCounts().future).toBe(0);
		} finally {
			await titledHarness.close();
		}
	});

	it("creates a scheduled future launch instead of an immediate process when requested", async () => {
		const initialProcessCount = harness.ctx.deps.processes.listAll().length;
		const initialFutureCount = harness.ctx.deps.futureExecutions.listAll().length;
		const runAt = futureIso();
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/scheduled-repo",
						prompt: "Implement later",
					},
					schedule: {
						mode: "once",
						runAt,
					},
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(body.futureExecution).toMatchObject({
			kind: "launch",
			scheduleKind: "once",
			launcherId: "launcher_test_process.local_repo_ui",
			nextRunAt: runAt,
		});
		expect(harness.ctx.deps.processes.listAll()).toHaveLength(initialProcessCount);
		expect(harness.ctx.deps.futureExecutions.listAll()).toHaveLength(initialFutureCount + 1);
	});

	it("rejects unknown schedule modes instead of treating them as immediate launches", async () => {
		const initialProcessCount = harness.ctx.deps.processes.listAll().length;
		const initialFutureCount = harness.ctx.deps.futureExecutions.listAll().length;
		const response = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/invalid-mode-repo",
						prompt: "Do not launch",
					},
					schedule: {
						mode: "later",
						runAt: futureIso(),
					},
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.errors).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "invalid_schedule" })]),
		);
		expect(harness.ctx.deps.processes.listAll()).toHaveLength(initialProcessCount);
		expect(harness.ctx.deps.futureExecutions.listAll()).toHaveLength(initialFutureCount);
	});

	it("keeps invalid scheduled launches visible in the process list", async () => {
		const execution = harness.ctx.deps.futureExecutions.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "launcher_test_process",
			launcherId: "launcher_test_process.local_repo_ui",
			payloadJson: "{",
			nextRunAt: "2026-04-26T09:00:00.000Z",
		});

		try {
			const response = await fetch(`${harness.address}/api/processes`);
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body.futureExecutions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: execution.id,
						kind: "launch",
						launcherId: "launcher_test_process.local_repo_ui",
						subtitle: expect.stringContaining("invalid"),
					}),
				]),
			);
		} finally {
			harness.ctx.deps.futureExecutions.delete(execution.id);
		}
	});

	it("previews the next cron run in UTC", async () => {
		const response = await fetch(`${harness.address}/api/future-executions/cron-preview`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expression: "0 9 * * 1-5" }),
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.nextRunAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T09:00:00\.000Z$/));
	});

	it("keeps the existing schedule when updating a scheduled launch without resubmitting schedule", async () => {
		const initialProcessCount = harness.ctx.deps.processes.listAll().length;
		const runAt = futureIso();
		const scheduledResponse = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/original-scheduled-repo",
						prompt: "Implement later",
					},
					schedule: {
						mode: "once",
						runAt,
					},
				}),
			},
		);
		const scheduledBody = await scheduledResponse.json();
		expect(scheduledResponse.status).toBe(201);

		const updateResponse = await fetch(
			`${harness.address}/api/future-executions/${scheduledBody.futureExecution.id}/launch`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/updated-scheduled-repo",
						prompt: "Implement later with edits",
					},
				}),
			},
		);
		const updateBody = await updateResponse.json();

		expect(updateResponse.status).toBe(200);
		expect(updateBody.futureExecution).toMatchObject({
			id: scheduledBody.futureExecution.id,
			nextRunAt: runAt,
			scheduleKind: "once",
		});
		expect(harness.ctx.deps.processes.listAll()).toHaveLength(initialProcessCount);
	});

	it("keeps the submitted title when updating only the schedule", async () => {
		const titledHarness = await createTitleTestHarness("Generated scheduled title");
		try {
			const scheduledResponse = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/title-preserve-repo",
							prompt: "Original prompt",
						},
						schedule: {
							mode: "once",
							runAt: futureIso(),
						},
					}),
				},
			);
			const scheduledBody = await scheduledResponse.json();
			expect(scheduledResponse.status).toBe(201);
			await waitFor(
				() => {
					const updated = titledHarness.ctx.deps.futureExecutions.getById(
						scheduledBody.futureExecution.id,
					);
					return updated
						? parseFutureLaunchPayloadOrThrow(updated.payloadJson).launchPlan.processInput.title
						: null;
				},
				(value) => value === "Generated scheduled title",
			);

			const updatedRunAt = futureIso(48 * 60);
			const updateResponse = await fetch(
				`${titledHarness.address}/api/future-executions/${scheduledBody.futureExecution.id}/launch`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title: "Generated scheduled title",
						schedule: {
							mode: "once",
							runAt: updatedRunAt,
						},
					}),
				},
			);
			const updateBody = await updateResponse.json();

			expect(updateResponse.status).toBe(200);
			expect(updateBody.futureExecution.title).toBe("Generated scheduled title");
			expect(updateBody.futureExecution.nextRunAt).toBe(updatedRunAt);
			expect(
				parseFutureLaunchPayloadOrThrow(
					titledHarness.ctx.deps.futureExecutions.getById(scheduledBody.futureExecution.id)
						?.payloadJson ?? "",
				).launchPlan.processInput.title,
			).toBe("Generated scheduled title");
			expect(titledHarness.getQueueCounts().future).toBe(1);
		} finally {
			await titledHarness.close();
		}
	});

	it("regenerates the scheduled title when launcher input changes and the submitted title is blank", async () => {
		const titledHarness = await createTitleTestHarness(
			(launchPlan) => `Generated: ${launchPlan.titleSourceFields?.[0]?.value ?? "missing"}`,
		);
		try {
			const scheduledResponse = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/title-refresh-repo",
							prompt: "Original prompt",
						},
						schedule: {
							mode: "once",
							runAt: futureIso(),
						},
					}),
				},
			);
			const scheduledBody = await scheduledResponse.json();
			expect(scheduledResponse.status).toBe(201);
			await waitFor(
				() => {
					const updated = titledHarness.ctx.deps.futureExecutions.getById(
						scheduledBody.futureExecution.id,
					);
					return updated
						? parseFutureLaunchPayloadOrThrow(updated.payloadJson).launchPlan.processInput.title
						: null;
				},
				(value) => value === "Generated: Original prompt",
			);

			const updateResponse = await fetch(
				`${titledHarness.address}/api/future-executions/${scheduledBody.futureExecution.id}/launch`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title: null,
						launcherInput: {
							repoPath: "/tmp/title-refresh-repo",
							prompt: "Updated prompt",
						},
						modelConfig: {},
						schedule: {
							mode: "once",
							runAt: futureIso(72 * 60),
						},
					}),
				},
			);
			await updateResponse.json();
			const updatedPayload = parseFutureLaunchPayloadOrThrow(
				titledHarness.ctx.deps.futureExecutions.getById(scheduledBody.futureExecution.id)
					?.payloadJson ?? "",
			);

			expect(updateResponse.status).toBe(200);
			expect(updatedPayload.launcherInput).toMatchObject({
				repoPath: "/tmp/title-refresh-repo",
				prompt: "Updated prompt",
			});
			await waitFor(
				() => {
					const updated = titledHarness.ctx.deps.futureExecutions.getById(
						scheduledBody.futureExecution.id,
					);
					return updated
						? parseFutureLaunchPayloadOrThrow(updated.payloadJson).launchPlan.processInput.title
						: null;
				},
				(value) => value === "Generated: Updated prompt",
			);
			expect(titledHarness.getQueueCounts().future).toBe(2);
		} finally {
			await titledHarness.close();
		}
	});

	it("uses the stored launcher payload when a scheduled launch is run now without resubmitting fields", async () => {
		const runAt = futureIso();
		const scheduledResponse = await fetch(
			`${harness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					launcherInput: {
						repoPath: "/tmp/repo-run-now-from-stored-payload",
						prompt: "Use the original payload",
						baseBranch: "develop",
					},
					modelConfig: {
						defaultModelProfileId: harness.ctx.config.pi.model_profiles[0]?.id ?? undefined,
					},
					schedule: {
						mode: "once",
						runAt,
					},
				}),
			},
		);
		const scheduledBody = await scheduledResponse.json();
		expect(scheduledResponse.status).toBe(201);

		const runNowResponse = await fetch(
			`${harness.address}/api/future-executions/${scheduledBody.futureExecution.id}/launch`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ schedule: { mode: "now" } }),
			},
		);
		const runNowBody = await runNowResponse.json();

		expect(runNowResponse.status).toBe(200);
		expect(runNowBody.process).toMatchObject({ processId: "launcher_test_process" });
		expect(runNowBody.projects).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					repoLocator: "/tmp/repo-run-now-from-stored-payload",
					baseBranch: "develop",
				}),
			]),
		);
		expect(harness.ctx.deps.futureExecutions.getById(scheduledBody.futureExecution.id)).toBeNull();
	});

	it("regenerates the process title when running a scheduled launch now with updated fields and a blank submitted title", async () => {
		const titledHarness = await createTitleTestHarness(
			(launchPlan) => `Generated: ${launchPlan.titleSourceFields?.[0]?.value ?? "missing"}`,
		);
		try {
			const scheduledResponse = await fetch(
				`${titledHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/run-now-title-repo",
							prompt: "Original prompt",
						},
						schedule: {
							mode: "once",
							runAt: futureIso(),
						},
					}),
				},
			);
			const scheduledBody = await scheduledResponse.json();
			expect(scheduledResponse.status).toBe(201);
			await waitFor(
				() => {
					const updated = titledHarness.ctx.deps.futureExecutions.getById(
						scheduledBody.futureExecution.id,
					);
					return updated
						? parseFutureLaunchPayloadOrThrow(updated.payloadJson).launchPlan.processInput.title
						: null;
				},
				(value) => value === "Generated: Original prompt",
			);

			const runNowResponse = await fetch(
				`${titledHarness.address}/api/future-executions/${scheduledBody.futureExecution.id}/launch`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						title: null,
						launcherInput: {
							repoPath: "/tmp/run-now-title-repo",
							prompt: "Updated prompt",
						},
						modelConfig: {},
						schedule: { mode: "now" },
					}),
				},
			);
			const runNowBody = await runNowResponse.json();

			expect(runNowResponse.status).toBe(200);
			expect(runNowBody.process.title).toBeNull();
			await waitFor(
				() => titledHarness.ctx.deps.processes.getById(runNowBody.process.id)?.title,
				(value) => value === "Generated: Updated prompt",
			);
			expect(
				titledHarness.ctx.deps.futureExecutions.getById(scheduledBody.futureExecution.id),
			).toBeNull();
			expect(titledHarness.getQueueCounts()).toEqual({ process: 1, future: 1 });
		} finally {
			await titledHarness.close();
		}
	});

	it("keeps consuming a scheduled launch when running it now partially succeeds", async () => {
		const failingSpawn = (() => {
			throw new Error("spawn failed intentionally");
		}) as typeof spawn;
		const failingHarness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([launcherTestExtension]),
			inProcessWorkers: false,
			appOverrides: { localWorkerSpawnImpl: failingSpawn },
			configOverride: applyLauncherModelConfig,
		});

		try {
			const runAt = futureIso();
			const scheduledResponse = await fetch(
				`${failingHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/repo-run-now-fail",
							prompt: "Run now later",
							startNow: true,
						},
						schedule: {
							mode: "once",
							runAt,
						},
					}),
				},
			);
			const scheduledBody = await scheduledResponse.json();
			expect(scheduledResponse.status).toBe(201);

			const runNowResponse = await fetch(
				`${failingHarness.address}/api/future-executions/${scheduledBody.futureExecution.id}/launch`,
				{
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/repo-run-now-fail",
							prompt: "Run now later",
							startNow: true,
						},
						schedule: { mode: "now" },
					}),
				},
			);
			const runNowBody = await runNowResponse.json();
			expect(runNowResponse.status).toBe(200);
			expect(runNowBody.process).toMatchObject({ processId: "launcher_test_process" });
			expect(
				failingHarness.ctx.deps.futureExecutions.getById(scheduledBody.futureExecution.id),
			).toBeNull();
		} finally {
			await failingHarness.ctx.app.close();
		}
	});

	it("returns partial-success failure details when process creation succeeds but worker start fails", async () => {
		const failingSpawn = (() => {
			throw new Error("spawn failed intentionally");
		}) as typeof spawn;
		const failingHarness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([launcherTestExtension]),
			inProcessWorkers: false,
			appOverrides: { localWorkerSpawnImpl: failingSpawn },
			configOverride: applyLauncherModelConfig,
		});

		try {
			const response = await fetch(
				`${failingHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/repo-start-fail",
							prompt: "Start but fail",
							startNow: true,
						},
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body.error).toBe("Process was created, but the worker could not be started cleanly");
			expect(body.process).toMatchObject({
				processId: "launcher_test_process",
				selectedTurnId: "launcher_plan_turn",
				lifecycleStatus: "active",
			});
			expect(body.projects).toEqual([
				expect.objectContaining({
					key: "repo",
					repoLocator: "/tmp/repo-start-fail",
				}),
			]);

			const persistedProcess = failingHarness.ctx.deps.processes.getById(body.process.id);
			const persistedProjects = failingHarness.ctx.deps.projects.listByInstance(body.process.id);
			expect(persistedProcess).toMatchObject({
				selectedTurnId: "launcher_plan_turn",
				lifecycleStatus: "error",
			});
			const failedStart =
				persistedProcess?.currentExecution?.kind === "worker_start"
					? failingHarness.ctx.deps.turnStarts.getById(persistedProcess.currentExecution.id)
					: null;
			expect(failedStart?.state).toMatchObject({
				kind: "bootstrap_failed",
				code: "worker_spawn_failed",
			});
			expect(persistedProjects).toHaveLength(1);
		} finally {
			await failingHarness.ctx.app.close();
		}
	});

	it("supports launchers that start the new process instance immediately", async () => {
		const startHarness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([launcherTestExtension]),
			inProcessWorkers: true,
			configOverride: applyLauncherModelConfig,
		});

		try {
			const response = await fetch(
				`${startHarness.address}/api/launchers/launcher_test_process.local_repo_ui/launch`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						launcherInput: {
							repoPath: "/tmp/repo-start-now",
							prompt: "Start immediately",
							startNow: true,
						},
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(201);
			expect(body.process).toMatchObject({
				processId: "launcher_test_process",
				selectedTurnId: "launcher_plan_turn",
				lifecycleStatus: "active",
			});

			const workerLease = await waitFor(
				() => startHarness.ctx.deps.leases.getByInstance(body.process.id),
				(value) => value !== null,
			);
			expect(workerLease).not.toBeNull();
		} finally {
			await startHarness.ctx.app.close();
		}
	});
});
