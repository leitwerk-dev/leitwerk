import { fixtureModelProfiles, fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createExtensionIntegrationHarness,
	type ExtensionIntegrationHarnessOptions,
} from "@leitwerk-dev/test-support/integration";
import showcaseProcessesExtension from "../index.js";

export function createShowcaseHarness(options: Partial<ExtensionIntegrationHarnessOptions> = {}) {
	return createExtensionIntegrationHarness({
		extensions: [
			showcaseProcessesExtension,
			{
				manifest: { id: "showcase-fixture-providers", version: "1" },
				modelProviders: fixtureModelProviders(
					...fixtureModelProfiles.map((model) => ({ ...model, id: model.provider, server: true })),
				),
			},
		],
		models: fixtureModelProfiles,
		defaultModel: fixtureModelProfiles[0].id,
		script(_id, _prompt, observation) {
			const names = new Set(observation.tools.map((tool) => tool.name));
			if (names.has("no_issues"))
				return {
					tools: [
						{ name: "no_issues", arguments: { review: "## Review\n\nReady.", summary: "Ready" } },
					],
				};

			return {
				tools: [
					{
						name: "markdown_result",
						arguments: {
							markdown:
								"# Cloud Dusk\n\nEvening servers hum in amber light,\nScaled dreams unfolding into night.",
						},
					},
				],
			};
		},
		...options,
	});
}
