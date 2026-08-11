import { afterEach, describe, expect, it, vi } from "vitest";
import modelsExtension, {
	createCustomGatewayProvider,
	createStandardModelProvider,
	getSupportedStandardProviders,
	manifest,
	parseApiKeyCredential,
	parseCustomGatewayConfig,
	parseStandardProviderConfig,
	resolveModelProviders,
} from "./index.js";

afterEach(() => vi.unstubAllEnvs());

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
		expect(manifest).toEqual({ id: "models", version: "0.1.0" });
		expect(entries?.some((entry) => entry.definition.id === "openai")).toBe(true);
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
		expect(parseStandardProviderConfig(raw, "openai")).toEqual({
			config: {},
			credential: { apiKey: expected },
		});
	});

	it("projects a configured standard-provider base URL into Pi models", () => {
		const parsed = parseStandardProviderConfig(
			{ api_key: "sk-azure", base_url: "https://resource.openai.azure.com/" },
			"azure-openai-responses",
		);
		expect(parsed).toEqual({
			config: { baseUrl: "https://resource.openai.azure.com" },
			credential: { apiKey: "sk-azure" },
		});
		const provider = createStandardModelProvider("azure-openai-responses");
		expect(provider.worker.kind).toBe("configured_pi_provider");
		if (provider.worker.kind !== "configured_pi_provider") throw new Error("unexpected worker");
		expect(provider.worker.resolveModels({ config: parsed.config })).toEqual({
			providers: {
				"azure-openai-responses": { baseUrl: "https://resource.openai.azure.com" },
			},
		});
	});

	it("resolves and normalizes a standard-provider base URL from the environment", () => {
		vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://resource.openai.azure.com/openai///");

		expect(
			parseStandardProviderConfig(
				{ api_key: "sk-azure", base_url: "env:AZURE_OPENAI_ENDPOINT" },
				"azure-openai-responses",
			),
		).toEqual({
			config: { baseUrl: "https://resource.openai.azure.com/openai" },
			credential: { apiKey: "sk-azure" },
		});
	});

	it.each([
		"ftp://resource.example.com",
		"not a URL",
		"",
	])("rejects invalid standard-provider base URL %j", (baseUrl) => {
		expect(() =>
			parseStandardProviderConfig({ api_key: "sk-provider", base_url: baseUrl }, "openai"),
		).toThrow();
	});

	it("rejects an unset standard-provider base URL environment reference", () => {
		vi.stubEnv("UNSET_PROVIDER_BASE_URL", "");
		expect(() =>
			parseStandardProviderConfig(
				{ api_key: "sk-provider", base_url: "env:UNSET_PROVIDER_BASE_URL" },
				"openai",
			),
		).toThrow(/unset environment variable/u);
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
		expect(provider.worker.kind).toBe("configured_pi_provider");
		if (provider.worker.kind !== "configured_pi_provider") throw new Error("unexpected worker");
		expect(provider.worker.resolveModels({ config: parsed.config })).toEqual({
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

	it("uses durable credential availability and declared model IDs for custom status", () => {
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

	it("creates configured worker and built-in server references for standard providers", () => {
		const provider = createStandardModelProvider("openai");
		expect(provider.worker.kind).toBe("configured_pi_provider");
		if (provider.worker.kind !== "configured_pi_provider") throw new Error("unexpected worker");
		expect(provider.worker.resolveModels({ config: {} })).toEqual({ providers: {} });
		expect(provider.server).toEqual({ kind: "builtin_pi_provider", providerId: "openai" });
	});
});
