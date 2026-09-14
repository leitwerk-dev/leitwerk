import type { OwnedModelProviderSet } from "@leitwerk-dev/extension-runtime";
import {
	builtinPiProvider,
	defineModelProvider,
	defineModelProviders,
	type ErasedModelProviderDefinition,
} from "@leitwerk-dev/process-sdk";

export function ownedProviderSet(
	definition: ErasedModelProviderDefinition,
	ownerExtensionId = "owner",
	packageName = `@test/${ownerExtensionId}`,
): OwnedModelProviderSet {
	return {
		ownerExtensionId,
		packageName,
		resolve: (rawConfig) => [{ definition, rawConfig }],
	};
}

export function fixtureModelProviders(
	...models: { id: string; modelId: string; piProvider?: string }[]
) {
	return defineModelProviders((rawConfig) =>
		models.map(({ id, modelId, piProvider = id }) => ({
			definition: defineModelProvider({
				id,
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider(piProvider),
				models: () => [{ modelId, availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		})),
	);
}
