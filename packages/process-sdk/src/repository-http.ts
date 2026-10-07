import { IntegrationHttpClient } from "./integration-http.js";
import type { RepositoryIssue, RepositoryPullRequest } from "./repository-types.js";

/** Common forge endpoints; extensions retain authentication and specialized operations. */
/** @public */
export class RepositoryHttpClient<Comment = Record<string, unknown>> extends IntegrationHttpClient {
	/** @internal */
	protected repositoryPath(owner: string, repo: string): string {
		return `/repos/${owner}/${repo}`;
	}

	/** @internal */
	getIssue(owner: string, repo: string, number: number, signal?: AbortSignal) {
		return this.request<RepositoryIssue>(`${this.repositoryPath(owner, repo)}/issues/${number}`, {
			signal,
		});
	}

	/** @public */
	listIssueComments(owner: string, repo: string, number: number, signal?: AbortSignal) {
		return this.pages<Comment>(
			`${this.repositoryPath(owner, repo)}/issues/${number}/comments`,
			signal,
		);
	}

	/** @public */
	addIssueComment(owner: string, repo: string, number: number, body: string, signal?: AbortSignal) {
		return this.writeJson(
			`${this.repositoryPath(owner, repo)}/issues/${number}/comments`,
			"POST",
			{ body },
			signal,
		);
	}

	/** @public */
	createPullRequest(
		owner: string,
		repo: string,
		input: {
			/** @public */
			title: string;
			/** @public */
			body: string;
			/** @public */
			head: string;
			/** @public */
			base: string;
		},
	) {
		return this.writeJson<RepositoryPullRequest>(
			`${this.repositoryPath(owner, repo)}/pulls`,
			"POST",
			input,
		);
	}

	/** @public */
	getPullRequest(owner: string, repo: string, number: number, signal?: AbortSignal) {
		return this.request<RepositoryPullRequest>(
			`${this.repositoryPath(owner, repo)}/pulls/${number}`,
			{ signal },
		);
	}

	/** @internal */
	listPullRequests(owner: string, repo: string, state = "open") {
		return this.pages<RepositoryPullRequest>(
			`${this.repositoryPath(owner, repo)}/pulls?state=${encodeURIComponent(state)}`,
		);
	}

	/** @public */
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
