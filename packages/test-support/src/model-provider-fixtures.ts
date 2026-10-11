import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
import type { ConfigSnapshot } from "@leitwerk-dev/protocol";
import type { ExtensionIntegrationHarnessOptions } from "./extension-integration-harness.js";

/** @internal */
export const fixtureModelProfiles: NonNullable<ExtensionIntegrationHarnessOptions["models"]> = [
	{
		id: "claude_fast",
		thinkingLevel: "medium",
		provider: "anthropic",
		modelId: "claude-sonnet-4-20250514",
	},
	{ id: "local_qwen", thinkingLevel: "low", provider: "ollama", modelId: "qwen2.5-coder:14b" },
];

/** @public */
export type FixtureModelProviderSet = ReturnType<typeof defineModelProviders>;

/** @public */
export function fixtureModelProviders(
	...models: {
		/** @public */
		id: string;
		/** @public */
		modelId: string;
		/** @internal */
		piProvider?: string;
		/** @public */
		server?: boolean;
	}[]
): FixtureModelProviderSet {
	return defineModelProviders((rawConfig) =>
		models.map(({ id, modelId, piProvider = id, server = false }) => ({
			definition: defineModelProvider({
				id,
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider(piProvider),
				...(server ? { server: builtinPiProvider(piProvider) } : {}),
				models: () => [{ modelId, availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		})),
	);
}

/** Explicit model wiring for server tests that do not exercise an LLM. @internal */
export function withDefaultModelFixture(
	config: ConfigSnapshot,
	catalog: ExtensionCatalog,
): ExtensionCatalog {
	if (config.pi.model_profiles.length === 0 && !config.pi.default_model_profile) {
		config.pi.default_model_profile = "test-support-fixture";
		config.pi.model_profiles = [
			{ id: "test-support-fixture", provider: "test-support-fixture", model_id: "fixture" },
		];
	}
	if (!config.pi.model_profiles.some((profile) => profile.provider === "test-support-fixture"))
		return catalog;
	return {
		...catalog,
		modelProviders: [
			...catalog.modelProviders,
			{
				ownerExtensionId: "test-support-fixture",
				packageName: "@leitwerk-dev/test-support",
				resolve: fixtureModelProviders({ id: "test-support-fixture", modelId: "fixture" }),
			},
		],
	};
}
