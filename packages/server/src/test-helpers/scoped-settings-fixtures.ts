import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import type { LeitwerkExtensionModule, SettingDefinition } from "@leitwerk-dev/process-sdk";
import { getDefaultConfig } from "../config/config-loader.js";
import { createAllRepos } from "../db/repositories.js";
import { buildProcessActionRegistry } from "../process-action-registry.js";
import { createServerProcessModelPolicy } from "../process-model-policy/index.js";
import { createScopedSettingsService } from "../scoped-settings-service.js";
import { createOwnedInMemoryDatabase } from "./owned-test-deps.js";
import {
	createFixtureHumanTurn,
	createFixtureLlmTurn,
	createFixtureProcess,
} from "./process-fixtures.js";

export const reportLabel: SettingDefinition<string> = {
	key: "settings-test.report_label",
	schemaVersion: 1,
	defaultValue: "Default report",
	scopes: [
		"instance",
		"settings-test.issue-type",
		"settings-test.project",
		"settings-test.project-issue-type",
	],
	merge: "replace",
	schema: {
		parse(value) {
			if (typeof value !== "string") throw new Error("Expected text");
			return value;
		},
	},
	form: { label: "Report label", control: "textarea", group: "Planning" },
};
export const repositoryLabel: SettingDefinition<string> = {
	...reportLabel,
	key: "settings-test.repository_label",
	scopes: ["instance", "repository"],
};
export const model: SettingDefinition<string | null> = {
	key: "settings-test.model",
	schemaVersion: 1,
	defaultValue: null,
	scopes: ["instance", "repository"],
	merge: "replace",
	schema: {
		parse(value) {
			if (value === null || typeof value === "string") return value;
			throw new Error("Expected a model profile");
		},
	},
	form: { label: "Planning model", control: "model", group: "Planning" },
};
const process = createFixtureProcess({
	id: "settings_process",
	entry: "run",
	turns: {
		run: createFixtureLlmTurn("Plan", { executionPurpose: "settings-test.planning" }),
		review: createFixtureHumanTurn({
			actions: { proceed: { label: "Proceed", acceptanceState: "accepted", to: "run" } },
		}),
	},
});
export const settingsExtension: LeitwerkExtensionModule = {
	manifest: { id: "settings-test", version: "1" },
	scopedSettings: {
		scopes: [
			{ id: "settings-test.issue-type", label: "Issue type" },
			{ id: "settings-test.project", label: "Project" },
			{ id: "settings-test.project-issue-type", label: "Project + issue type" },
		],
		settings: [reportLabel, repositoryLabel, model],
		purposes: [
			{
				id: "settings-test.planning",
				label: "Planning",
				modelSettingKey: model.key,
				settingKeys: [reportLabel.key, repositoryLabel.key],
			},
		],
	},
	setupCatalog(api) {
		api.registerProcess(process);
	},
};

export function createSettingsProcess(repos: ReturnType<typeof createAllRepos>, keys: string[]) {
	const process = repos.processes.create({ processId: "settings_process", selectedTurnId: "run" });
	for (const key of keys)
		repos.projects.create({
			instanceId: process.id,
			key,
			repoLocator: `/workspace/${key}`,
			baseBranch: "main",
		});
	return process;
}

export async function createSettingsFixture(
	repos = createAllRepos(createOwnedInMemoryDatabase()),
	modules = [settingsExtension],
) {
	const catalog: ExtensionCatalog = await buildExtensionCatalogFromModules(modules);
	const config = getDefaultConfig();
	config.pi.default_model_profile = "first";
	config.pi.model_profiles = [
		{ id: "first", provider: "test", model_id: "one" },
		{ id: "second", provider: "test", model_id: "two" },
	];
	config.process_configs = modules.length
		? {
				settings_process: {
					default_model_profile: "first",
					turn_configs: { run: { model_profile: "first" } },
				},
			}
		: {};
	const settings = createScopedSettingsService({ repos, catalog, config });
	const policy = createServerProcessModelPolicy({
		config,
		processGraphs: catalog.processes,
		processActionRegistry: buildProcessActionRegistry(catalog),
		scopedSettings: settings,
	});
	return { repos, catalog, config, settings, policy };
}
