import type { OwnedModelProviderSet } from "@leitwerk-dev/extension-runtime";
import type { ErasedModelProviderDefinition } from "@leitwerk-dev/process-sdk";

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
