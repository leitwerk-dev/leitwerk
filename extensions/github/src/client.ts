import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type RepositoryFeedbackItem as GitHubFeedbackItem,
	normalizeRepositoryFeedback as normalize,
} from "@leitwerk-dev/process-sdk";

export type { GitHubFeedbackItem };

export interface GitHubProfile {
	apiBaseUrl: string;
	token: string;
	botLogin: string;
}

export interface GitHubIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	html_url: string;
	updated_at: string;
	user: { login: string };
	labels: Array<{ id: number; name: string }>;
}

export interface GitHubPullRequest {
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

export interface GitHubCheckSummary {
	headSha: string;
	status: "pending" | "success" | "failure";
	total: number;
	failed: Array<{
		name: string;
		conclusion: string | null;
		url: string | null;
	}>;
}

export interface GitHubRelease {
	id: number;
	tag_name: string;
	target_commitish: string;
	draft: boolean;
	prerelease: boolean;
	html_url: string;
	assets: Array<{ name: string; url: string; browser_download_url: string }>;
}

export function parseGitHubProfiles(value: unknown): Map<string, GitHubProfile> {
	const profiles = new Map<string, GitHubProfile>();
	for (const [name, raw] of Object.entries(
		asUnknownRecord(asUnknownRecord(value)?.profiles) ?? {},
	)) {
		const config = asUnknownRecord(raw) ?? {};
		const apiBaseUrl =
			typeof config.api_base_url === "string"
				? config.api_base_url.replace(/\/+$/, "")
				: "https://api.github.com";
		const token = typeof config.token === "string" ? config.token.trim() : "";
		const botLogin = typeof config.bot_login === "string" ? config.bot_login.trim() : "leitwerk";
		if (!/^https:\/\//.test(apiBaseUrl))
			throw new Error(`GitHub profile '${name}' requires an HTTPS api_base_url`);
		if (!token) throw new Error(`GitHub profile '${name}' requires a token`);
		if (!botLogin) throw new Error(`GitHub profile '${name}' requires bot_login`);
		profiles.set(name, { apiBaseUrl, token, botLogin });
	}
	return profiles;
}

export class GitHubClient {
	constructor(readonly profile: GitHubProfile) {}

	private async response(path: string, init: RequestInit = {}): Promise<Response> {
		const response = await fetch(`${this.profile.apiBaseUrl}${path}`, {
			...init,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${this.profile.token}`,
				"X-GitHub-Api-Version": "2022-11-28",
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
		});
		if (!response.ok)
			throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed with ${response.status}`);
		return response;
	}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await this.response(path, init);
		return response.status === 204 ? (undefined as T) : response.json();
	}

	private async pages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
		const items: T[] = [];
		for (let page = 1; ; page++) {
			const separator = path.includes("?") ? "&" : "?";
			const batch = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`, {
				signal,
			});
			items.push(...batch);
			if (batch.length < 100) return items;
		}
	}

	getIssue(owner: string, repo: string, number: number, signal?: AbortSignal) {
		return this.request<GitHubIssue>(`/repos/${owner}/${repo}/issues/${number}`, { signal });
	}

	getCommit(owner: string, repo: string, ref: string) {
		return this.request<{ sha: string }>(
			`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
		);
	}

	async isAncestor(owner: string, repo: string, ancestor: string, descendant: string) {
		const comparison = await this.request<{ status: string }>(
			`/repos/${owner}/${repo}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}`,
		);
		return comparison.status === "identical" || comparison.status === "ahead";
	}

	listIssueComments(owner: string, repo: string, number: number, signal?: AbortSignal) {
		return this.pages<Record<string, unknown>>(
			`/repos/${owner}/${repo}/issues/${number}/comments`,
			signal,
		);
	}

	addIssueComment(owner: string, repo: string, number: number, body: string, signal?: AbortSignal) {
		return this.request(`/repos/${owner}/${repo}/issues/${number}/comments`, {
			method: "POST",
			body: JSON.stringify({ body }),
			signal,
		});
	}

	createPullRequest(
		owner: string,
		repo: string,
		input: { title: string; body: string; head: string; base: string },
	) {
		return this.request<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls`, {
			method: "POST",
			body: JSON.stringify(input),
		});
	}

	getPullRequest(owner: string, repo: string, number: number, signal?: AbortSignal) {
		return this.request<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls/${number}`, { signal });
	}

	listPullRequests(owner: string, repo: string, state = "open") {
		return this.pages<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls?state=${state}`);
	}

	updatePullRequest(
		owner: string,
		repo: string,
		number: number,
		patch: Record<string, unknown>,
		signal?: AbortSignal,
	) {
		return this.request<GitHubPullRequest>(`/repos/${owner}/${repo}/pulls/${number}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
			signal,
		});
	}

	async listPullRequestFeedback(
		owner: string,
		repo: string,
		number: number,
		signal?: AbortSignal,
	): Promise<GitHubFeedbackItem[]> {
		const prefix = `/repos/${owner}/${repo}`;
		const [conversation, reviews, inline] = await Promise.all([
			this.pages<Record<string, unknown>>(`${prefix}/issues/${number}/comments`, signal),
			this.pages<Record<string, unknown>>(`${prefix}/pulls/${number}/reviews`, signal),
			this.pages<Record<string, unknown>>(`${prefix}/pulls/${number}/comments`, signal),
		]);
		return [
			...conversation.map((item) => normalize("conversation", item)),
			...reviews.map((item) => normalize("review", item)),
			...inline.map((item) => normalize("inline", item)),
		].filter((item): item is GitHubFeedbackItem => item !== null);
	}

	async getCheckSummary(owner: string, repo: string, headSha: string): Promise<GitHubCheckSummary> {
		const response = await this.request<{
			check_runs: Array<Record<string, unknown>>;
		}>(`/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`);
		const terminalSuccess = new Set(["success", "neutral", "skipped"]);
		const failed = response.check_runs
			.filter((run) => run.status === "completed" && !terminalSuccess.has(String(run.conclusion)))
			.map((run) => ({
				name: String(run.name ?? "unknown"),
				conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
				url: typeof run.html_url === "string" ? run.html_url : null,
			}));
		const pending = response.check_runs.some((run) => run.status !== "completed");
		return {
			headSha,
			status: failed.length
				? "failure"
				: pending || !response.check_runs.length
					? "pending"
					: "success",
			total: response.check_runs.length,
			failed,
		};
	}

	listReleases(owner: string, repo: string) {
		return this.pages<GitHubRelease>(`/repos/${owner}/${repo}/releases`);
	}

	downloadReleaseAsset(asset: GitHubRelease["assets"][number]): Promise<string> {
		const url = new URL(asset.url);
		if (`${url.protocol}//${url.host}` !== this.profile.apiBaseUrl)
			throw new Error("GitHub release asset URL does not match the configured API origin");
		return this.response(`${url.pathname}${url.search}`, {
			headers: { Accept: "application/octet-stream" },
		}).then((response) => response.text());
	}
}
