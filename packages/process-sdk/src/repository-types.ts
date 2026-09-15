/** Common issue and pull-request response fields used by repository integrations. */
export interface RepositoryIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	html_url: string;
	updated_at: string;
	user: { login: string };
	labels: Array<{ id: number; name: string }>;
}

export interface RepositoryPullRequest {
	number: number;
	title: string;
	body: string | null;
	state: string;
	merged: boolean;
	mergeable?: boolean | null;
	mergeable_state?: string | null;
	merge_commit_sha: string | null;
	html_url: string;
	head: { ref: string; sha: string };
	base: { ref: string; sha: string };
}
