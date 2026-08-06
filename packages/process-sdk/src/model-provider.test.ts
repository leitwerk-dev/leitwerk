import { describe, expect, it, vi } from "vitest";
import {
	builtinPiProvider,
	configuredPiProvider,
	defineModelProvider,
	defineModelProviders,
	defineProviderOptions,
	defineWorkerConfig,
	filterProviderOptionsForDefinition,
	piServer,
	piWorker,
	resolveProviderOptions,
} from "./model-provider.js";

describe("provider option resolution", () => {
	it("uses explicit, profile, then provider defaults without consulting choices", () => {
		const choices = vi.fn();
		const definition = defineProviderOptions<{ account: string }>({
			fields: {
				explicit: { label: "Explicit", required: true },
				profile: { label: "Profile", required: true },
				provider: {
					label: "Provider",
					required: true,
					defaultValue: ({ config }) => config.account,
				},
				optional: { label: "Optional" },
			},
			choices,
		});

		expect(
			resolveProviderOptions({
				definition,
				config: { account: "provider-account" },
				explicit: { explicit: "submitted" },
				profileDefaults: { profile: "configured" },
			}),
		).toEqual({
			ok: true,
			value: {
				explicit: "submitted",
				profile: "configured",
				provider: "provider-account",
			},
		});
		expect(choices).not.toHaveBeenCalled();
	});

	it("treats choices as advisory and accepts values absent from them", () => {
		const definition = defineProviderOptions({
			fields: { account: { label: "Account", required: true } },
			choices: () => ({ account: [{ value: "visible", label: "Visible" }] }),
		});
		expect(
			resolveProviderOptions({
				definition,
				config: {},
				explicit: { account: "hidden-but-valid" },
			}),
		).toEqual({ ok: true, value: { account: "hidden-but-valid" } });
	});

	it("rejects unknown, non-string, bounded, and missing required fields", () => {
		const definition = defineProviderOptions({
			fields: {
				account: { label: "Account", required: true, minLength: 2, maxLength: 4 },
			},
		});
		const unknown = resolveProviderOptions({
			definition,
			config: {},
			explicit: { other: "value" },
		});
		expect(unknown.ok).toBe(false);
		expect(!unknown.ok && unknown.issues.map((issue) => issue.code)).toContain("unknown");

		for (const [value, code] of [
			[1, "not_string"],
			["x", "too_short"],
			["lengthy", "too_long"],
		] as const) {
			const result = resolveProviderOptions({
				definition,
				config: {},
				explicit: { account: value },
			});
			expect(result.ok).toBe(false);
			expect(!result.ok && result.issues[0]?.code).toBe(code);
		}

		const missing = resolveProviderOptions({ definition, config: {} });
		expect(missing.ok).toBe(false);
		expect(!missing.ok && missing.issues[0]?.code).toBe("required");
	});

	it("drops options not declared by a newly selected provider", () => {
		const definition = defineProviderOptions({
			fields: { retained: { label: "Retained" } },
		});
		expect(
			filterProviderOptionsForDefinition(definition, { retained: "yes", oldProviderOnly: "no" }),
		).toEqual({ retained: "yes" });
	});
});

describe("model provider definitions", () => {
	it("declares extension worker/server entries and deterministic worker config", () => {
		const config = defineWorkerConfig<{ url: string }, { brokerUrl: string }>({
			version: 1,
			schema: {
				parse(value) {
					return value as { brokerUrl: string };
				},
			},
			resolve: ({ config: parsed }) => ({ brokerUrl: parsed.url }),
		});
		const provider = defineModelProvider({
			id: "nifto",
			parseConfig: (raw) => ({ config: raw as { url: string } }),
			worker: piWorker({ config }),
			server: piServer(),
			models: () => [],
			secrets: () => ({}),
		});
		expect(provider.worker).toEqual({ kind: "extension_pi_worker", config });
		expect(provider.server).toEqual({ kind: "extension_pi_server" });
		expect(config.resolve({ config: { url: "https://broker" }, options: {} })).toEqual({
			brokerUrl: "https://broker",
		});
	});

	it("supports explicit built-in Pi adapters without registering a provider implicitly", () => {
		expect(builtinPiProvider("openai")).toEqual({
			kind: "builtin_pi_provider",
			providerId: "openai",
		});
	});

	it("resolves configured Pi models and extension-owned provider sets", () => {
		const worker = configuredPiProvider<{ baseUrl: string }>("gateway", ({ config }) => ({
			providers: { gateway: { baseUrl: config.baseUrl, models: [] } },
		}));
		expect(worker.resolveModels({ config: { baseUrl: "https://gateway.test" } })).toEqual({
			providers: { gateway: { baseUrl: "https://gateway.test", models: [] } },
		});
		const definition = defineModelProvider({
			id: "gateway",
			parseConfig: (raw) => ({ config: raw }),
			worker,
			models: () => [],
			secrets: () => ({}),
		});
		const providers = defineModelProviders((rawConfig) => [{ definition, rawConfig }]);
		expect(providers({ baseUrl: "https://gateway.test" })).toEqual([
			{ definition, rawConfig: { baseUrl: "https://gateway.test" } },
		]);
	});
});
