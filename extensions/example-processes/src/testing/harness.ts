import { fixtureModelProviders } from "@leitwerk-dev/test-support";
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
					{ id: "anthropic", modelId: "claude-sonnet-4-20250514", server: true },
					{ id: "ollama", modelId: "qwen2.5-coder:14b", server: true },
				),
			},
		],
		models: [
			{
				id: "claude_fast",
				thinkingLevel: "medium",
				provider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
			},
			{ id: "local_qwen", thinkingLevel: "low", provider: "ollama", modelId: "qwen2.5-coder:14b" },
		],
		defaultModel: "claude_fast",
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
