import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
} from "@leitwerk-dev/process-sdk";

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
