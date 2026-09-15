import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";

export function fixtureModelProviders(
	...models: { id: string; modelId: string; piProvider?: string; server?: boolean }[]
) {
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
