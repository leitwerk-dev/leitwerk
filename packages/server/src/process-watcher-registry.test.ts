import {
	defineProcess,
	type ExtensionProcessDefinition,
	type LauncherModelProfileSummary,
	llmTurn,
} from "@leitwerk-dev/process-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";
import {
	buildProcessWatcherRegistry,
	validateConfiguredProcessWatchersAgainstCatalog,
} from "./process-watcher-registry.js";

interface TestParams {
	issueKey: string;
}

interface TestState {
	issueKey: string;
}

const defaultModelProfiles: readonly LauncherModelProfileSummary[] = [
	{ id: "claude_fast", provider: "anthropic", modelId: "claude", thinkingLevel: "medium" },
	{ id: "local_qwen", provider: "ollama", modelId: "qwen", thinkingLevel: "low" },
] as const;

const filteredModelProfiles: readonly LauncherModelProfileSummary[] = [defaultModelProfiles[1]];

const observedWatcherContexts: LauncherModelProfileSummary[][] = [];

const testProcess = defineProcess<TestParams, TestState>({
	id: "test_process",
	displayName: "Test Process",
	entry: "triage",
	paramsCodec: {
		parse(value) {
			const candidate = typeof value === "object" && value !== null ? value : {};
			return {
				issueKey:
					typeof (candidate as { issueKey?: unknown }).issueKey === "string"
						? (candidate as { issueKey: string }).issueKey
						: "",
			};
		},
		serialize(value) {
			return value;
		},
	},
	stateCodec: {
		parse(value) {
			const candidate = typeof value === "object" && value !== null ? value : {};
			return {
				issueKey:
					typeof (candidate as { issueKey?: unknown }).issueKey === "string"
						? (candidate as { issueKey: string }).issueKey
						: "",
			};
		},
		serialize(value) {
			return value;
		},
	},
	initialState(params) {
		return { issueKey: params.issueKey };
	},
	turns: {
		triage: llmTurn({
			availableTools: [],
			description: "Triage",
			branchType: "primary",
			context: "fresh",
			prompt: async () => "triage",
			turnEnd: { outcome: "done", params: {}, complete: true },
		}),
	},
	watchers(api) {
		api.watcher({
			id: "jira_default",
			label: "Jira Default",
			description: "Watch Jira",
			type: "jira",
			matches(event, ctx) {
				observedWatcherContexts.push([...(ctx.modelProfiles ?? [])]);
				return (event as { reject?: boolean }).reject !== true;
			},
			resolveLaunchConfig(event, ctx) {
				observedWatcherContexts.push([...(ctx.modelProfiles ?? [])]);
				const candidate = event as { issueKey: string; summary?: string };
				return {
					processId: "test_process",
					params: { issueKey: candidate.issueKey },
					title: candidate.summary ?? null,
					externalId: candidate.issueKey,
					startTurnId: "triage",
				};
			},
		});
	},
});

const duplicateWatcherProcess: ExtensionProcessDefinition = {
	...testProcess,
	watchers(api) {
		api.watcher({
			id: "jira_default",
			label: "Jira Default",
			description: "Watch Jira",
			type: "jira",
			resolveLaunchConfig: () => ({ processId: "test_process", params: {} }),
		});
		api.watcher({
			id: "jira_default",
			label: "Jira Duplicate",
			description: "Watch Jira duplicate",
			type: "jira",
			resolveLaunchConfig: () => ({ processId: "test_process", params: {} }),
		});
	},
};

function createConfig() {
	const config = getDefaultConfig();
	config.process_configs = {
		test_process: {
			turn_configs: {},
			watchers: {
				jira_default: {
					type: "jira",
					enabled: true,
					project: "CLD",
					poll_interval: "60s",
					labels: { trigger: "use-leitwerk", done: "did-use-leitwerk" },
					target_branch_label_prefix: "target-branch:",
					launch: {
						default_model_profile: "claude_fast",
						turn_configs: { triage: { model_profile: "local_qwen" } },
					},
				},
			},
		},
	};
	return config;
}

function createRegistry() {
	return buildProcessWatcherRegistry(
		{ processes: new Map([["test_process", testProcess]]) },
		createConfig(),
		{
			modelProfiles: defaultModelProfiles,
			getModelProfilesForProcess: (processId) =>
				processId === "test_process" ? filteredModelProfiles : [],
		},
	);
}

describe("buildProcessWatcherRegistry", () => {
	beforeEach(() => {
		observedWatcherContexts.length = 0;
	});

	it("fails startup and config validation when a process declares duplicate watcher ids", () => {
		const catalog = { processes: new Map([["test_process", duplicateWatcherProcess]]) };

		expect(() => buildProcessWatcherRegistry(catalog, createConfig())).toThrowError();
		expect(() =>
			validateConfiguredProcessWatchersAgainstCatalog({ config: createConfig(), catalog }),
		).toThrowError();
	});

	it("accepts removed watcher model defaults while retaining structural validation", () => {
		const config = createConfig();
		config.process_configs.test_process.watchers.jira_default.launch = {
			default_model_profile: "removed_default",
			turn_configs: { triage: { model_profile: "removed_turn_default" } },
		};
		const processModelPolicy = {
			project: () => ({ profiles: [], turns: [{ turnId: "triage", description: "Triage" }] }),
			evaluate: () => {
				throw new Error("inherited watcher profiles must not be validated as explicit selections");
			},
			fingerprint: () => "",
		} as unknown as ServerProcessModelPolicy;

		expect(
			validateConfiguredProcessWatchersAgainstCatalog({
				config,
				catalog: { processes: new Map([["test_process", testProcess]]) },
				processModelPolicy,
			}),
		).toEqual([]);
	});

	it("canonicalizes watcher-provided titles in launch plans", async () => {
		const registry = createRegistry();
		const resolved = await registry.resolveLaunch("test_process", "jira_default", {
			issueKey: "CLD-101",
			summary: "  Implement\n caching layer  ",
		});

		expect(resolved?.launchPlan.processInput.title).toBe("Implement caching layer");
		expect(resolved?.launchPlan.processInput.externalId).toBe("CLD-101");
	});

	it("returns null when a watcher match rejects the payload", async () => {
		const registry = createRegistry();

		await expect(
			registry.resolveLaunch("test_process", "jira_default", {
				issueKey: "CLD-102",
				reject: true,
			}),
		).resolves.toBeNull();
		expect(observedWatcherContexts).toEqual([filteredModelProfiles]);
	});

	it("adds watcher metadata and configured launch model config", async () => {
		const registry = createRegistry();

		const resolved = await registry.resolveLaunch("test_process", "jira_default", {
			issueKey: "CLD-103",
			summary: "Watcher metadata",
		});

		expect(resolved?.watcher.launchModelConfig).toEqual({
			defaultModelProfileId: "claude_fast",
			turnConfigs: { triage: { modelProfileId: "local_qwen" } },
		});
		expect(resolved?.launchPlan.launcherId).toBe("test_process.jira_default");
		expect(resolved?.launchPlan.processInput.metadata).toEqual({
			processWatcherId: "jira_default",
			processWatcherType: "jira",
			processWatcherConfigPath: "process_configs.test_process.watchers.jira_default",
		});
	});

	it("passes process-filtered model profiles to watcher matches and resolution", async () => {
		const registry = createRegistry();

		await registry.resolveLaunch("test_process", "jira_default", { issueKey: "CLD-104" });

		expect(observedWatcherContexts).toEqual([filteredModelProfiles, filteredModelProfiles]);
	});

	it("preserves explicitly supplied model profiles in watcher context", async () => {
		const registry = createRegistry();
		const explicitProfiles = [defaultModelProfiles[0]];

		await registry.resolveLaunch(
			"test_process",
			"jira_default",
			{ issueKey: "CLD-105" },
			{
				modelProfiles: explicitProfiles,
			},
		);

		expect(observedWatcherContexts).toEqual([explicitProfiles, explicitProfiles]);
	});
});
