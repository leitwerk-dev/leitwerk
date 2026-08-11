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
		sourceId: "showcase.file",
		sourceLabel: "File",
		enabled: true,
		configPath: "process_configs.poem_creator_process.watchers.create_poem",
		targetSummary: "File /tmp/create-poem",
		details: [
			{ label: "File path", value: "/tmp/create-poem", format: "code" },
			{ label: "Poll interval", value: "1s" },
		],
		launchModel: {
			defaultModelProfileId: "local_qwen",
			turnConfigs: [],
		},
	},
	{
		processId: "ticket_issue_process",
		processDisplayName: "Implement Ticket Issue",
		watcherId: "ticket_default",
		label: "Ticket Issue Watcher",
		description: "Create issue processes from configured work discovery",
		sourceId: "example.work_queue",
		sourceLabel: "Work queue",
		enabled: true,
		configPath: "process_configs.ticket_issue_process.watchers.ticket_default",
		targetSummary: "Project APP",
		details: [
			{ label: "Project", value: "APP" },
			{ label: "Trigger", value: "ready" },
			{ label: "Forbidden labels", value: "hotfix" },
		],
		launchModel: {
			defaultModelProfileId: "claude_fast",
			turnConfigs: [],
		},
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
		expect(target.textContent).toContain("Ticket Issue Watcher");
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
