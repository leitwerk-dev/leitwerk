import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type RepositoryFeedbackItem as GitHubFeedbackItem,
	type RepositoryIssue as GitHubIssue,
	type RepositoryPullRequest as GitHubPullRequest,
	normalizeRepositoryFeedback as normalize,
	RepositoryHttpClient,
} from "@leitwerk-dev/process-sdk";

export type { GitHubFeedbackItem, GitHubIssue, GitHubPullRequest };

export interface GitHubProfile {
	apiBaseUrl: string;
	token: string;
	botLogin: string;
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

export class GitHubClient extends RepositoryHttpClient {
	constructor(readonly profile: GitHubProfile) {
		super("GitHub", profile.apiBaseUrl, {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${profile.token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		});
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
