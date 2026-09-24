import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createExtensionIntegrationHarness,
	type ExtensionIntegrationHarness,
	type ExtensionIntegrationHarnessOptions,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import singlePromptExtension from "../index.js";

export function createShowcaseHarness(options: Partial<ExtensionIntegrationHarnessOptions> = {}) {
	return createExtensionIntegrationHarness({
		extensions: [
			singlePromptExtension,
			{
				manifest: { id: "showcase-fixture-providers", version: "1" },
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
			if (names.has("no_issues"))
				return {
					tools: [
						{ name: "no_issues", arguments: { review: "## Review\n\nReady.", summary: "Ready" } },
					],
				};
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

/** Keep HTTP assertions on the supported request interface. */
export async function http(test: ExtensionIntegrationHarness, url: string, init: RequestInit = {}) {
	const response = await test.request({
		url,
		method: (init.method ?? "GET") as "GET" | "POST" | "DELETE",
		...(init.body ? { payload: JSON.parse(String(init.body)) } : {}),
	});
	return { status: response.statusCode, json: response.json };
}

/** Admit a launch and observe its process without requiring a transient lifecycle state. */
export async function launchProcess(
	test: ExtensionIntegrationHarness,
	launcherId: string,
	launcherInput: { prompt: string },
	defaultModelProfileId: string,
) {
	const admitted = await test.request({
		method: "POST",
		url: `/api/launchers/${launcherId}/launch-runs`,
		headers: { "idempotency-key": crypto.randomUUID() },
		payload: { launcherInput, modelConfig: { defaultModelProfileId }, schedule: { mode: "now" } },
	});
	if (admitted.statusCode !== 202) throw new Error(`Launch admission failed: ${admitted.body}`);
	const { launchRunId } = admitted.json<{ launchRunId: string }>();
	const launchRun = await waitForValue(
		async () => {
			const response = await test.request({ url: `/api/launch-runs/${launchRunId}` });
			const { launchRun } = response.json<{
				launchRun: { status: string; instanceId: string | null };
			}>();
			if (launchRun.status === "failed" && !launchRun.instanceId)
				throw new Error(`Launch did not commit: ${response.body}`);
			return launchRun;
		},
		(run) => run.instanceId !== null,
		12000,
	);
	if (!launchRun.instanceId) throw new Error("Missing launched process");
	return test.process(launchRun.instanceId).snapshot().process;
}
