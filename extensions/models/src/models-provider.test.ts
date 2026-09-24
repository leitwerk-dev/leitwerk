import type { ModelProviderWorker } from "@leitwerk-dev/process-sdk";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import modelsExtension from "./index.js";
import {
	createCustomGatewayProvider,
	createStandardModelProvider,
	parseApiKeyCredential,
	parseCustomGatewayConfig,
	parseStandardProviderConfig,
	resolveModelProviders,
} from "./models-provider.js";
import { getSupportedStandardProviders } from "./provider-auth.js";

afterEach(() => vi.unstubAllEnvs());

function resolveModels<T>(worker: ModelProviderWorker<T>, config: T) {
	assert(worker.kind === "configured_pi_provider", "Expected a configured Pi provider");
	return worker.resolveModels({ config });
}

const customGateway = {
	base_url: "https://llm-gateway.example.com/v1",
	api_key: false,
	api: "openai-completions",
	models: [
		{
			id: "gemma-4-31b-it",
			name: "Gemma 4 31B IT",
			reasoning: true,
			context_window: 262_144,
			max_tokens: 32_768,
		},
	],
};

describe("models extension", () => {
	it("resolves standard and configuration-defined providers through one provider set", () => {
		const entries = modelsExtension.modelProviders?.({
			openai: { api_key: "sk-openai" },
			custom_gateways: { "internal-gateway": customGateway },
		});
		expect(modelsExtension.manifest.id).toBe("models");
		expect(entries?.find((entry) => entry.definition.id === "openai")?.rawConfig).toEqual({
			api_key: "sk-openai",
		});
		expect(entries?.find((entry) => entry.definition.id === "internal-gateway")?.rawConfig).toBe(
			customGateway,
		);
	});

	it("exposes the Pi built-ins that use standard API-key credentials", () => {
		const providers = getSupportedStandardProviders();
		expect(providers).toEqual(expect.arrayContaining(["openai", "anthropic", "google"]));
		expect(providers).not.toContain("amazon-bedrock");
	});

	it.each([
		[{ api_key: "sk-literal" }, "sk-literal"],
		[{ api_key: "env:MODELS_TEST_KEY" }, "sk-environment"],
	] as const)("parses a configured standard API key", (raw, expected) => {
		vi.stubEnv("MODELS_TEST_KEY", "sk-environment");
		vi.stubEnv("OPENAI_API_KEY", "ambient-key");
		expect(parseStandardProviderConfig(raw, "openai")).toEqual({
			config: {},
			credential: { apiKey: expected },
		});
	});

	it.each([
		["https://resource.openai.azure.com/", undefined, "https://resource.openai.azure.com"],
		[
			"env:AZURE_OPENAI_ENDPOINT",
			"https://resource.openai.azure.com/openai///",
			"https://resource.openai.azure.com/openai",
		],
	] as const)("normalizes standard-provider base URL %j", (baseUrl, environmentUrl, expected) => {
		if (environmentUrl) vi.stubEnv("AZURE_OPENAI_ENDPOINT", environmentUrl);
		expect(
			parseStandardProviderConfig(
				{ api_key: "sk-azure", base_url: baseUrl },
				"azure-openai-responses",
			),
		).toEqual({ config: { baseUrl: expected }, credential: { apiKey: "sk-azure" } });
	});

	it.each([
		["ftp://resource.example.com", undefined],
		["not a URL", undefined],
		["", undefined],
		["env:UNSET_PROVIDER_BASE_URL", ""],
	] as const)("rejects invalid standard-provider base URL %j", (baseUrl, environmentUrl) => {
		if (environmentUrl !== undefined) vi.stubEnv("UNSET_PROVIDER_BASE_URL", environmentUrl);
		expect(() =>
			parseStandardProviderConfig({ api_key: "sk-provider", base_url: baseUrl }, "openai"),
		).toThrow();
	});

	it("uses Pi's standard environment key when provider config is omitted", () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-openai-environment");
		expect(parseStandardProviderConfig(undefined, "openai")).toEqual({
			config: {},
			credential: { apiKey: "sk-openai-environment" },
		});
	});

	it("strictly validates credentials and owner configuration", () => {
		expect(parseApiKeyCredential({ apiKey: " key " }, "openai")).toEqual({ apiKey: "key" });
		expect(() => parseApiKeyCredential({ apiKey: "key", token: "no" }, "openai")).toThrow(
			"unknown field 'token'",
		);
		expect(() => resolveModelProviders({ typo: {} })).toThrow("unknown field 'typo'");
	});

	it("builds credential-blind Pi models for a keyless custom gateway", () => {
		const parsed = parseCustomGatewayConfig("internal-gateway", customGateway);
		const provider = createCustomGatewayProvider("internal-gateway", true);
		expect(parsed).toEqual({
			config: {
				providerId: "internal-gateway",
				baseUrl: "https://llm-gateway.example.com/v1",
				api: "openai-completions",
				keyless: true,
				models: [
					{
						id: "gemma-4-31b-it",
						name: "Gemma 4 31B IT",
						reasoning: true,
						contextWindow: 262_144,
						maxTokens: 32_768,
					},
				],
			},
		});
		expect(resolveModels(provider.worker, parsed.config)).toEqual({
			providers: {
				"internal-gateway": {
					baseUrl: "https://llm-gateway.example.com/v1",
					api: "openai-completions",
					models: parsed.config.models,
				},
			},
		});
		expect(provider.secrets({ config: parsed.config, credential: null, options: {} })).toEqual({
			apiKey: "leitwerk-keyless",
		});
	});

	it("resolves declared custom model IDs when credentials are available", () => {
		const parsed = parseCustomGatewayConfig("internal-gateway", {
			...customGateway,
			api_key: "sk-gateway",
		});
		const provider = createCustomGatewayProvider("internal-gateway", false);
		expect(
			provider.models({
				config: parsed.config,
				configuredModels: [
					{ profileId: "known", modelId: "gemma-4-31b-it" },
					{ profileId: "unknown", modelId: "missing" },
				],
				credentialStatus: { available: true, revision: 1 },
			}),
		).toEqual([
			{ modelId: "gemma-4-31b-it", availability: "available" },
			{
				modelId: "missing",
				availability: "unavailable",
				safeReason:
					"Canonical model 'internal-gateway/missing' is not found in custom gateway definition",
			},
		]);
	});

	it("preserves compatibility, thinking levels, input and cost without projecting credentials", () => {
		const compat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
		};
		const thinkingLevelMap = {
			off: null,
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "high",
		};
		const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const parsed = parseCustomGatewayConfig("local", {
			base_url: "http://localhost:1234/v1",
			api_key: "fixture-secret",
			compat,
			models: [
				{
					id: "reasoner",
					reasoning: true,
					thinking_level_map: thinkingLevelMap,
					input: ["text"],
					context_window: 262144,
					max_tokens: 65536,
					cost,
				},
			],
		});
		expect(parsed.credential).toEqual({ apiKey: "fixture-secret" });
		const provider = createCustomGatewayProvider("local", false);
		const projected = resolveModels(provider.worker, parsed.config);
		expect(projected).toEqual({
			providers: {
				local: {
					baseUrl: "http://localhost:1234/v1",
					api: "openai-completions",
					compat,
					models: [
						{
							id: "reasoner",
							reasoning: true,
							thinkingLevelMap,
							input: ["text"],
							contextWindow: 262144,
							maxTokens: 65536,
							cost,
						},
					],
				},
			},
		});
		expect(JSON.stringify(projected)).not.toContain("fixture-secret");
	});

	it("registers explicit standard-provider models alongside the built-in catalog", () => {
		const provider = createStandardModelProvider("azure-openai-responses");
		const parsed = parseStandardProviderConfig(
			{
				api_key: "fixture-secret",
				base_url: "https://azure.example/openai/v1",
				models: [{ id: "new-deployment", reasoning: true, thinking_level_map: { xhigh: "xhigh" } }],
			},
			"azure-openai-responses",
		);
		const configuredModels = [
			{ profileId: "new", modelId: "new-deployment" },
			{ profileId: "existing", modelId: "gpt-5.6-luna" },
		];
		expect(
			provider.models({
				config: parsed.config,
				configuredModels,
				credentialStatus: { available: true, revision: 1 },
			}),
		).toEqual(configuredModels.map(({ modelId }) => ({ modelId, availability: "available" })));
		expect(
			provider.models({
				config: parsed.config,
				configuredModels,
				credentialStatus: { available: false, revision: null },
			}),
		).toEqual(
			configuredModels.map(({ modelId }) =>
				expect.objectContaining({ modelId, availability: "unavailable" }),
			),
		);
		const projected = resolveModels(provider.worker, parsed.config);
		expect(projected).toHaveProperty(
			["providers", "azure-openai-responses", "models"],
			[
				expect.objectContaining({
					id: "new-deployment",
					api: "azure-openai-responses",
					provider: "azure-openai-responses",
					baseUrl: "https://azure.example/openai/v1",
					reasoning: true,
					thinkingLevelMap: { xhigh: "xhigh" },
					contextWindow: 128_000,
					maxTokens: 16_384,
				}),
			],
		);
		expect(JSON.stringify(projected)).not.toContain("fixture-secret");
	});

	it.each([
		{ models: [{ id: "duplicate" }, { id: "duplicate" }] },
		{ models: [{ id: "model", thinking_level_map: { typo: "high" } }] },
		{ models: [{ id: "model", cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
		{ compat: { supportsStore: "false" } },
		{ compat: { apiKey: "not-a-compatibility-setting" } },
	])("rejects malformed model metadata and compatibility settings", (override) => {
		expect(() => parseCustomGatewayConfig("test", { ...customGateway, ...override })).toThrow();
	});

	it("projects empty and configured standard workers with a built-in server reference", () => {
		const provider = createStandardModelProvider("openai");
		expect(resolveModels(provider.worker, {})).toEqual({ providers: {} });
		expect(resolveModels(provider.worker, { baseUrl: "https://proxy.example.test/v1" })).toEqual({
			providers: { openai: { baseUrl: "https://proxy.example.test/v1" } },
		});
		expect(provider.server).toEqual({ kind: "builtin_pi_provider", providerId: "openai" });
	});
});
