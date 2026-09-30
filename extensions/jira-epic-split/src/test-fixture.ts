import { LocalGitLabAdapter } from "@leitwerk-dev/gitlab/testing";
import type { JiraIssue } from "@leitwerk-dev/jira";
import { LocalJiraSplitAdapter as LocalJiraAdapter } from "@leitwerk-dev/jira/testing";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";

/** @internal */
export function createSplitSources(root: string, sourceType = "Epic") {
	const git = new LocalGit(root);
	const gitlab = new LocalGitLabAdapter(root);
	for (const name of ["one", "two"])
		gitlab.addProject(
			`team/${name}`,
			git.seed({ owner: "team", name, files: { "README.md": "Old standard" } }).bare,
		);
	const jira = new LocalJiraAdapter();
	const epic: JiraIssue = {
		id: "10",
		key: "APP-10",
		fields: {
			summary: "Standardize readmes",
			description: "Use the shared sections",
			issuetype: { id: sourceType.toLowerCase(), name: sourceType, subtask: false },
			project: { id: "100", key: "APP", name: "App" },
			components: [],
			labels: [],
			status: { statusCategory: { key: "new" } },
		},
	};
	jira.seedIssue(epic);
	return { git, gitlab, jira, epic };
}
