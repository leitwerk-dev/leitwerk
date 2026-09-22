import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createExtensionIntegrationHarness,
	type ExtensionIntegrationHarness,
	type ExtensionIntegrationHarnessOptions,
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

/** Observe asynchronous launch admission without exposing server state. */
export async function launchRequest(
	test: ExtensionIntegrationHarness,
	url: string,
	init: RequestInit,
): Promise<{ status: number; json(): unknown }> {
	const admitted = await test.request({
		method: "POST",
		url,
		headers: { "idempotency-key": crypto.randomUUID() },
		payload: { ...JSON.parse(String(init.body)), schedule: { mode: "now" } },
	});
	if (admitted.statusCode !== 202) return { status: admitted.statusCode, json: admitted.json };
	const { launchRunId } = admitted.json<{ launchRunId: string }>();
	const deadline = Date.now() + 12000;
	for (;;) {
		const response = await test.request({ url: `/api/launch-runs/${launchRunId}` });
		const { launchRun } = response.json<{
			launchRun: { status: string; instanceId: string | null };
		}>();
		if (launchRun.instanceId) {
			const snapshot = test.process(launchRun.instanceId).snapshot();
			return {
				status: launchRun.status === "failed" ? 200 : 201,
				json: () => ({ process: snapshot.process, projects: snapshot.projects }),
			};
		}
		if (launchRun.status === "failed" || Date.now() >= deadline)
			throw new Error(`Launch did not commit: ${response.body}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
