// @vitest-environment jsdom

import { mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWatchers, type WatcherSummary } from "../lib/api.js";
import WatchersPage from "./WatchersPage.svelte";

vi.mock("../lib/api.js", () => ({
	fetchWatchers: vi.fn(),
}));

const watcherSummaries: WatcherSummary[] = [
	{
		processId: "poem_creator_process",
		processDisplayName: "Poem Creator",
		watcherId: "create_poem",
		label: "Create Poem from File",
		description:
			"Launch Poem Creator whenever the configured filesystem watcher finds a prompt file",
		type: "filesystem",
		enabled: true,
		pollInterval: "1s",
		configPath: "process_configs.poem_creator_process.watchers.create_poem",
		targetSummary: "File /tmp/create-poem",
		launchModel: {
			defaultModelProfileId: "local_qwen",
			turnConfigs: [],
		},
		filePath: "/tmp/create-poem",
	},
	{
		processId: "jira_issue_process",
		processDisplayName: "Implement Jira Issue",
		watcherId: "jira_default",
		label: "Jira Issue Watcher",
		description: "Create Implement Jira Issue processes from configured Jira issue discovery",
		type: "jira",
		enabled: true,
		pollInterval: "60s",
		configPath: "process_configs.jira_issue_process.watchers.jira_default",
		targetSummary: "Jira project APP · trigger use-leitwerk",
		launchModel: {
			defaultModelProfileId: "claude_fast",
			turnConfigs: [],
		},
		project: "APP",
		labels: {
			trigger: "use-leitwerk",
			done: "did-use-leitwerk",
			forbidden: ["hotfix"],
		},
		targetBranchLabelPrefix: "target-branch:",
	},
];

async function flush() {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("WatchersPage", () => {
	it("renders registered watcher summaries", async () => {
		vi.mocked(fetchWatchers).mockResolvedValue(watcherSummaries.map((watcher) => ({ ...watcher })));
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(WatchersPage, { target });
		await flush();

		expect(target.textContent).toContain("Watchers");
		expect(target.textContent).toContain("Create Poem from File");
		expect(target.textContent).toContain("/tmp/create-poem");
		expect(target.textContent).toContain("Jira Issue Watcher");
		expect(target.textContent).toContain("Forbidden labels");
		unmount(app);
	});

	it("renders an empty state when no watchers are configured", async () => {
		vi.mocked(fetchWatchers).mockResolvedValue([]);
		const target = document.createElement("div");
		document.body.appendChild(target);

		const app = mount(WatchersPage, { target });
		await flush();

		expect(target.textContent).toContain("No watchers are currently registered.");
		unmount(app);
	});
});
