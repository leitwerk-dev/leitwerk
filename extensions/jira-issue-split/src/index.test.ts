import { LocalJiraSplitAdapter as LocalJiraAdapter } from "@leitwerk-dev/jira/testing";
import { expect, it } from "vitest";
import splitter, { issueSplitSource, jiraIssueSplitProcess } from "./index.js";
import { initialSplitState, parseDraft, type SplitParams } from "./model.js";

const config = {
	enabled: true,
	jiraProfile: "team",
	gitlabProfile: "team",
	sshProfile: "team",
	jiraProjects: ["100"],
	groups: "team, platform/shared",
	excludeProjects: "team/legacy",
};

it("uses the renamed extension while preserving durable process and watcher identities", () => {
	expect(splitter.manifest.id).toBe("jira-issue-split");
	expect(jiraIssueSplitProcess.id).toBe("jira_epic_split_process");
	expect(jiraIssueSplitProcess.entryTurnId).toBe("read_epic");
	expect([...jiraIssueSplitProcess.turns.keys()]).toEqual([
		"read_epic",
		"discover_candidates",
		"assess_repository",
		"prepare_review",
		"batch_review",
		"revise_drafts",
		"publish_tickets",
		"complete_split",
	]);
	expect(issueSplitSource.id).toBe("@leitwerk-dev/jira-epic-split.epic");
});

it("requires revision before approving a saved draft containing internal references", () => {
	const params = { labels: [], repositories: [] } as unknown as SplitParams;
	const state = initialSplitState(params);
	state.drafts = [
		parseDraft({
			repositoryKey: "repo_1",
			verdict: "applicable",
			reason: "The template needs updating",
			evidence: "README.md uses the previous template",
			revision: "a".repeat(40),
			summary: "Update README template",
			description: "Update the template. Reference: repo_1",
			issueType: "Story",
		}),
	];
	const review = jiraIssueSplitProcess.turns.get("batch_review")?.definition;
	if (review?.kind !== "human") throw new Error("Expected human review");
	const approve = review.actions.approve_batch.effect;
	if (!approve) throw new Error("Expected approval validation");
	const effect = () => approve({ ctx: { params, state }, input: {} } as never);
	expect(effect).toThrow("Revise the ticket");
	state.drafts[0].description = "Update the template. Acceptance: README has the shared sections.";
	expect(effect()).toMatchObject({ state: { approved: ["repo_1"] } });
});

it("requires explicit valid repository scope and Jira project IDs at configuration time", () => {
	expect(issueSplitSource.parseConfig(config)).toEqual({
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
		expect(() => issueSplitSource.parseConfig({ ...config, ...invalid })).toThrow();
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
