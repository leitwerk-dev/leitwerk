import {
	BUILT_IN_COMMIT_MESSAGE_RULES,
	COMMIT_MESSAGE_PROJECT_METADATA_KEY,
	type ProcessLaunchConfig,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import type { CommitMessageConfig } from "./config/config-types.js";
import { buildProcessLaunchPlan } from "./process-launch-plan.js";
import { createFixtureProcess } from "./test-helpers/process-fixtures.js";

const processDef = createFixtureProcess({ id: "test", entry: "run" });
const commitMessages: CommitMessageConfig = {
	templates: {
		conventional: { rules: "Use Conventional Commits." },
		concise: { rules: "Use a short subject." },
	},
	default_template: "concise",
	repositories: { "  https://example.test/repo.git///": "conventional" },
};

function projectMetadata(repoLocator: string, config?: CommitMessageConfig) {
	const launchConfig: ProcessLaunchConfig = {
		processId: "test",
		params: {},
		projects: [{ key: "repo", repoLocator, baseBranch: "main" }],
	};
	return buildProcessLaunchPlan({
		processDef,
		launchConfig,
		launcherId: "test.launcher",
		commitMessages: config,
	}).projectInputs[0]?.metadata?.[COMMIT_MESSAGE_PROJECT_METADATA_KEY];
}

describe("process launch commit-message policy", () => {
	it.each([
		{
			name: "normalized repository override",
			locator: "https://example.test/repo.git/",
			config: commitMessages,
			expected: { templateId: "conventional", rules: "Use Conventional Commits." },
		},
		{
			name: "default template",
			locator: "https://example.test/other.git",
			config: commitMessages,
			expected: { templateId: "concise", rules: "Use a short subject." },
		},
		{
			name: "built-in rules",
			locator: "https://example.test/other.git",
			config: undefined,
			expected: { templateId: null, rules: BUILT_IN_COMMIT_MESSAGE_RULES },
		},
	])("pins $name", ({ locator, config, expected }) => {
		expect(projectMetadata(locator, config)).toEqual(expected);
	});
});
