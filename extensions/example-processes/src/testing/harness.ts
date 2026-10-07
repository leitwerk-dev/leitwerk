import { fixtureModelProfiles, fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createExtensionIntegrationHarness,
	type ExtensionIntegrationHarnessOptions,
} from "@leitwerk-dev/test-support/integration";
import exampleProcessesExtension from "../index.js";

export function createExampleHarness(options: Partial<ExtensionIntegrationHarnessOptions> = {}) {
	return createExtensionIntegrationHarness({
		extensions: [
			exampleProcessesExtension,
			{
				manifest: { id: "example-fixture-providers", version: "1" },
				modelProviders: fixtureModelProviders(
					...fixtureModelProfiles.map((model) => ({ ...model, id: model.provider, server: true })),
				),
			},
		],
		models: fixtureModelProfiles,
		defaultModel: fixtureModelProfiles[0].id,
		script(_id, _prompt, observation) {
			const names = new Set(observation.tools.map((tool) => tool.name));
			if (names.has("done"))
				return {
					tools: [
						{
							name: "done",
							arguments: { summary: "Completed", markdown: "# Result\n\nCompleted." },
						},
					],
				};
			return {
				tools: [
					{
						name: "markdown_result",
						arguments: {
							markdown: "# Result\n\nCompleted.",
						},
					},
				],
			};
		},
		...options,
	});
}
