import type { GitLabMergeRequest } from "./client.js";

export const mr: GitLabMergeRequest = {
	iid: 1,
	project_id: 7,
	source_project_id: 7,
	target_project_id: 7,
	title: "Upgrade",
	description: null,
	state: "opened",
	labels: ["renovate"],
	sha: "head",
	source_branch: "renovate/dependency",
	target_branch: "main",
	web_url: "https://forge.test/a/-/merge_requests/1",
};
