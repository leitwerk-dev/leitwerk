import {
	defineProcess,
	defineProcessWatcherSource,
	type ExtensionProcessDefinition,
	type LauncherModelProfileSummary,
	llmTurn,
	parseProcessWatcherLaunchModelConfig,
} from "@leitwerk-dev/process-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import type { ServerProcessModelPolicy } from "./process-model-policy/index.js";
import { buildProcessWatcherRegistry } from "./process-watcher-registry.js";

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

interface TestWatcherConfig {
	project: string;
}

interface TestWatcherEvent {
	issueKey: string;
	summary?: string;
	reject?: boolean;
}

const testWatcherSource = defineProcessWatcherSource<TestWatcherConfig, TestWatcherEvent>({
	id: "test_ticket",
	label: "Test ticket source",
	parseConfig(raw) {
		const config = raw as { enabled?: boolean; project?: unknown; launch?: unknown };
		if (typeof config.project !== "string" || config.project.trim() === "") {
			throw new Error("project must be a non-empty string");
		}
		return {
			config: { project: config.project },
			enabled: config.enabled !== false,
			launchModelConfig: parseProcessWatcherLaunchModelConfig(config.launch),
		};
	},
	presentConfig(config) {
		return {
			targetSummary: config.project,
			details: [{ label: "Project", value: config.project }],
		};
	},
});

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
			id: "ticket_default",
			label: "Ticket Default",
			description: "Watch Ticket",
			source: testWatcherSource,
			matches(event, ctx) {
				observedWatcherContexts.push([...(ctx.modelProfiles ?? [])]);
				return event.reject !== true;
			},
			resolveLaunchConfig(event, ctx) {
				observedWatcherContexts.push([...(ctx.modelProfiles ?? [])]);
				return {
					processId: "test_process",
					params: { issueKey: event.issueKey },
					title: event.summary ?? null,
					externalId: event.issueKey,
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
			id: "ticket_default",
			label: "Ticket Default",
			description: "Watch Ticket",
			source: testWatcherSource,
			resolveLaunchConfig: () => ({ processId: "test_process", params: {} }),
		});
		api.watcher({
			id: "ticket_default",
			label: "Ticket Duplicate",
			description: "Watch Ticket duplicate",
			source: testWatcherSource,
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
				ticket_default: {
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

function configuredWatcher(registry: ReturnType<typeof createRegistry>) {
	const watcher = registry.listBySource(testWatcherSource)[0];
	if (!watcher) throw new Error("Expected configured test watcher");
	return watcher;
}

describe("buildProcessWatcherRegistry", () => {
	beforeEach(() => {
		observedWatcherContexts.length = 0;
	});

	it("fails startup when a process declares duplicate watcher ids", () => {
		const catalog = { processes: new Map([["test_process", duplicateWatcherProcess]]) };
		expect(() => buildProcessWatcherRegistry(catalog, createConfig())).toThrowError();
	});

	it("accepts removed watcher model defaults while retaining structural validation", () => {
		const config = createConfig();
		config.process_configs.test_process.watchers.ticket_default.launch = {
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

		expect(() =>
			buildProcessWatcherRegistry({ processes: new Map([["test_process", testProcess]]) }, config, {
				processModelPolicy,
			}),
		).not.toThrow();
	});

	it("canonicalizes watcher-provided titles in launch plans", async () => {
		const registry = createRegistry();
		const resolved = await configuredWatcher(registry).resolveLaunch({
			issueKey: "CLD-101",
			summary: "  Implement\n caching layer  ",
		});

		expect(resolved?.processInput.title).toBe("Implement caching layer");
		expect(resolved?.processInput.externalId).toBe("CLD-101");
	});

	it("returns null when a watcher match rejects the payload", async () => {
		const registry = createRegistry();

		await expect(
			configuredWatcher(registry).resolveLaunch({
				issueKey: "CLD-102",
				reject: true,
			}),
		).resolves.toBeNull();
		expect(observedWatcherContexts).toEqual([filteredModelProfiles]);
	});

	it("adds watcher metadata and configured launch model config", async () => {
		const registry = createRegistry();

		const resolved = await configuredWatcher(registry).resolveLaunch({
			issueKey: "CLD-103",
			summary: "Watcher metadata",
		});

		expect(configuredWatcher(registry).launchModelConfig).toEqual({
			defaultModelProfileId: "claude_fast",
			turnConfigs: { triage: { modelProfileId: "local_qwen" } },
		});
		expect(resolved?.launcherId).toBe("test_process.ticket_default");
		expect(resolved?.processInput.metadata).toEqual({
			processWatcherId: "ticket_default",
			processWatcherSourceId: "test_ticket",
			processWatcherConfigPath: "process_configs.test_process.watchers.ticket_default",
		});
	});

	it("passes process-filtered model profiles to watcher matches and resolution", async () => {
		const registry = createRegistry();

		await configuredWatcher(registry).resolveLaunch({ issueKey: "CLD-104" });

		expect(observedWatcherContexts).toEqual([filteredModelProfiles, filteredModelProfiles]);
	});

	it("preserves explicitly supplied model profiles in watcher context", async () => {
		const registry = createRegistry();
		const explicitProfiles = [defaultModelProfiles[0]];

		await configuredWatcher(registry).resolveLaunch(
			{ issueKey: "CLD-105" },
			{
				modelProfiles: explicitProfiles,
			},
		);

		expect(observedWatcherContexts).toEqual([explicitProfiles, explicitProfiles]);
	});
});
