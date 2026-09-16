import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import showcaseProcessesExtension from "@leitwerk-dev/showcase-processes";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";

export const fixtureModelProfile = {
	id: "test",
	provider: "fixture",
	model_id: "fixture-model",
	thinking_level: "off" as const,
};

export function createShowcaseModelCatalog() {
	return buildExtensionCatalogFromModules([
		{
			...showcaseProcessesExtension,
			modelProviders: fixtureModelProviders({
				id: fixtureModelProfile.provider,
				modelId: fixtureModelProfile.model_id,
				piProvider: "openai",
			}),
		},
	]);
}
