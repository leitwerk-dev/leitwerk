import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";
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
