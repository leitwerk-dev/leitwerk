import { LocalJiraAdapter } from "@leitwerk-dev/jira/testing";
import { expect, it } from "vitest";
import { epicSplitSource } from "./index.js";

const config = {
	enabled: true,
	jiraProfile: "team",
	gitlabProfile: "team",
	sshProfile: "team",
	jiraProjects: ["100"],
	groups: "team, platform/shared",
	excludeProjects: "team/legacy",
};

it("requires explicit valid repository scope and Jira project IDs at configuration time", () => {
	expect(epicSplitSource.parseConfig(config)).toEqual({
		enabled: true,
		config: { ...config, pollInterval: "30s" },
	});
	for (const invalid of [
		{ groups: "" },
		{ groups: ["team"] },
		{ excludeProjects: "team/*" },
		{ jiraProjects: ["APP"] },
		{ labels: ["use-leitwerk"] },
		{ labels: "leitwerk-epic-split" },
		{ labels: "leitwerk-issue-split" },
		{ issueType: "Bug" },
		{ subtaskIssueType: 10003 },
		{ subtaskIssueType: "Sub-task" },
		{ pollInterval: "0s" },
	])
		expect(() => epicSplitSource.parseConfig({ ...config, ...invalid })).toThrow();
});

it("discovers open parent issues once across both trigger labels", async () => {
	const jira = new LocalJiraAdapter();
	for (const [id, name, labels, subtask, status] of [
		["1", "Epic", ["leitwerk-epic-split"], false, "new"],
		["2", "Story", ["leitwerk-issue-split", "leitwerk-epic-split"], false, "new"],
		["3", "Bug", ["leitwerk-issue-split"], false, "new"],
		["4", "Sub-task", ["leitwerk-issue-split"], true, "new"],
		["5", "Task", ["leitwerk-issue-split"], false, "done"],
		["6", "Task", ["use-leitwerk"], false, "new"],
	] as const) {
		jira.seedIssue({
			id,
			key: `APP-${id}`,
			fields: {
				issuetype: { id: name, name, subtask },
				summary: name,
				description: null,
				labels: [...labels],
				project: { id: "100", key: "APP", name: "App" },
				components: [],
				status: { statusCategory: { key: status } },
			},
		});
	}
	expect((await jira.searchSplitIssues(["100"])).map((issue) => issue.id)).toEqual(["1", "2", "3"]);
	expect(await jira.searchSplitIssues(["200"])).toEqual([]);
});
