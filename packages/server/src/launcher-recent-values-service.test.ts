import type { ProcessLauncherService, UiLauncherSummary } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./db/database.js";
import { createAllRepos } from "./db/repositories.js";
import { createLauncherRecentValuesService } from "./launcher-recent-values-service.js";

function launcher(): UiLauncherSummary {
	return {
		id: "local_repo_change_process.ui_launcher",
		processId: "local_repo_change_process",
		displayName: "Local Repo Change",
		label: "Local Repo Change",
		description: "Change a repo",
		card: {},
		launchConfigSchema: {
			id: "local_repo_change_form",
			title: "Local Repo Change",
			fields: [
				{
					id: "repoLocator",
					label: "Repository path or URL",
					kind: "text",
					required: true,
					rememberRecentValues: true,
				},
				{ id: "prompt", label: "Prompt", kind: "textarea", required: true },
			],
		},
	};
}

function launcherService(): ProcessLauncherService {
	const summary = launcher();
	return {
		listUiLaunchers: () => [summary],
		resolveUiDefaults: async () => ({}),
		resolveUiOptions: async () => ({}),
		resolveUiLauncher: async () => ({ ok: false, errors: [] }),
	};
}

describe("launcher recent values service", () => {
	it("records only normalized values for fields that opt in", () => {
		const repos = createAllRepos(createInMemoryDatabase());
		const service = createLauncherRecentValuesService({
			repos,
			launcherService: launcherService(),
		});

		service.record("local_repo_change_process.ui_launcher", {
			repoLocator: "  /tmp/repo-a  ",
			prompt: "Do not store this",
		});
		service.record("local_repo_change_process.ui_launcher", {
			repoLocator: "https://token@example.com/org/repo.git",
		});

		expect(service.list("local_repo_change_process.ui_launcher")).toEqual({
			repoLocator: ["/tmp/repo-a"],
		});
	});
});
