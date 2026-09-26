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

export const instructions: SettingDefinition<string> = {
	key: "settings-test.instructions",
	schemaVersion: 1,
	defaultValue: "Code instructions",
	scopes: [
		"instance",
		"settings-test.issue-type",
		"settings-test.project",
		"settings-test.project-issue-type",
	],
	merge: "instructions",
	schema: {
		parse(value) {
			if (typeof value !== "string") throw new Error("Expected text");
			return value;
		},
	},
	form: { label: "Instructions", control: "textarea", group: "Planning" },
};
export const repositoryInstructions: SettingDefinition<string> = {
	...instructions,
	key: "settings-test.repository_instructions",
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
		settings: [instructions, repositoryInstructions, model],
		purposes: [
			{
				id: "settings-test.planning",
				label: "Planning",
				modelSettingKey: model.key,
				instructionSettingKeys: [repositoryInstructions.key],
				settingKeys: [instructions.key],
			},
		],
	},
	setupCatalog(api) {
		api.registerProcess(process);
	},
};

export async function createSettingsFixture(
	repos = createAllRepos(createOwnedInMemoryDatabase()),
	modules = [settingsExtension],
) {
	const catalog = await buildExtensionCatalogFromModules(modules);
	const config = getDefaultConfig();
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
