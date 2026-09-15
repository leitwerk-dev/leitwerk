import { IntegrationHttpClient } from "./integration-http.js";
import type { RepositoryIssue, RepositoryPullRequest } from "./repository-types.js";

/** Common forge endpoints; extensions retain authentication and specialized operations. */
export class RepositoryHttpClient<Comment = Record<string, unknown>> extends IntegrationHttpClient {
	protected repositoryPath(owner: string, repo: string): string {
		return `/repos/${owner}/${repo}`;
	}

	getIssue(owner: string, repo: string, number: number, signal?: AbortSignal) {
		return this.request<RepositoryIssue>(`${this.repositoryPath(owner, repo)}/issues/${number}`, {
			signal,
		});
	}

	listIssueComments(owner: string, repo: string, number: number, signal?: AbortSignal) {
		return this.pages<Comment>(
			`${this.repositoryPath(owner, repo)}/issues/${number}/comments`,
			signal,
		);
	}

	addIssueComment(owner: string, repo: string, number: number, body: string, signal?: AbortSignal) {
		return this.writeJson(
			`${this.repositoryPath(owner, repo)}/issues/${number}/comments`,
			"POST",
			{ body },
			signal,
		);
	}

	createPullRequest(
		owner: string,
		repo: string,
		input: { title: string; body: string; head: string; base: string },
	) {
		return this.writeJson<RepositoryPullRequest>(
			`${this.repositoryPath(owner, repo)}/pulls`,
			"POST",
			input,
		);
	}

	getPullRequest(owner: string, repo: string, number: number, signal?: AbortSignal) {
		return this.request<RepositoryPullRequest>(
			`${this.repositoryPath(owner, repo)}/pulls/${number}`,
			{ signal },
		);
	}

	listPullRequests(owner: string, repo: string, state = "open") {
		return this.pages<RepositoryPullRequest>(
			`${this.repositoryPath(owner, repo)}/pulls?state=${encodeURIComponent(state)}`,
		);
	}

	updatePullRequest(
		owner: string,
		repo: string,
		number: number,
		patch: Record<string, unknown>,
		signal?: AbortSignal,
	) {
		return this.writeJson<RepositoryPullRequest>(
			`${this.repositoryPath(owner, repo)}/pulls/${number}`,
			"PATCH",
			patch,
			signal,
		);
	}
}
