import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type RepositoryFeedbackItem as GitHubFeedbackItem,
	type RepositoryIssue as GitHubIssue,
	type RepositoryPullRequest as GitHubPullRequest,
	IntegrationHttpError,
	normalizeRepositoryFeedback as normalize,
	RepositoryHttpClient,
} from "@leitwerk-dev/process-sdk";

import { actionableFeedback, authorizedTrigger } from "./authorization.js";

export type { GitHubFeedbackItem, GitHubIssue, GitHubPullRequest };

/** @internal */
interface GitHubLabel {
	/** @internal */
	id: number;
	/** @internal */
	name: string;
}

/** @public */
export interface GitHubRepository {
	/** @public */
	name: string;
	/** @internal */
	full_name: string;
	/** @public */
	owner: {
		/** @public */
		login: string;
	};
	/** @public */
	ssh_url: string;
	/** @public */
	default_branch: string;
	/** @internal */
	html_url: string;
	/** @internal */
	archived: boolean;
	/** @internal */
	has_issues: boolean;
}
/** @public */
export interface GitHubGitIdentity {
	/** @internal */
	provider: "github";
	/** @internal */
	profile: string;
	/** @internal */
	login: string;
	/** @public */
	name: string;
	/** @public */
	email: string;
}
/** @public */
export interface GitHubLabelEvent {
	/** @internal */
	id: number;
	/** @internal */
	event: string;
	/** @public */
	label?: {
		/** @public */
		name: string;
	};
	/** @public */
	actor: {
		/** @public */
		login: string;
	} | null;
}

/** @internal */
export interface GitHubProfile {
	/** @internal */
	apiBaseUrl: string;
	/** @internal */
	token: string;
	/** @internal */
	botLogin: string;
	/** @internal */
	allowedOrganization?: string;
}

/** @public */
export interface GitHubCheckSummary {
	/** @public */
	headSha: string;
	/** @public */
	status: "pending" | "success" | "failure";
	/** @public */
	total: number;
	/** @public */
	failed: Array<{
		/** @internal */
		name: string;
		/** @public */
		conclusion: string | null;
		/** @public */
		url: string | null;
	}>;
}

/** @public */
export interface GitHubRelease {
	/** @internal */
	id: number;
	/** @public */
	tag_name: string;
	/** @internal */
	target_commitish: string;
	/** @internal */
	draft: boolean;
	/** @internal */
	prerelease: boolean;
	/** @internal */
	html_url: string;
	/** @public */
	assets: Array<{
		/** @public */
		name: string;
		/** @public */
		url: string;
		/** @public */
		browser_download_url: string;
	}>;
}

/** @internal */
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
		const allowedOrganization = config.allowed_organization;
		if (
			allowedOrganization !== undefined &&
			(typeof allowedOrganization !== "string" || !/^[a-z0-9-]+$/i.test(allowedOrganization))
		) {
			throw new Error(`GitHub profile '${name}' requires a valid allowed_organization`);
		}
		profiles.set(name, {
			apiBaseUrl,
			token,
			botLogin,
			...(typeof allowedOrganization === "string"
				? { allowedOrganization: allowedOrganization.toLowerCase() }
				: {}),
		});
	}
	return profiles;
}

/** @internal */
export function assertGitHubRepository(profile: GitHubProfile, owner: string, repo: string): void {
	if (
		!/^[a-z0-9-]+$/i.test(owner) ||
		!/^[a-z0-9_.-]+$/i.test(repo) ||
		repo === "." ||
		repo === ".."
	) {
		throw new Error("Invalid GitHub repository");
	}
	if (
		profile.allowedOrganization &&
		owner.toLowerCase() !== profile.allowedOrganization.toLowerCase()
	) {
		throw new Error(`GitHub project must belong to ${profile.allowedOrganization}`);
	}
}

/** @public */
export class GitHubClient extends RepositoryHttpClient {
	/** @internal */
	constructor(/** @internal */ readonly profile: GitHubProfile) {
		super("GitHub", profile.apiBaseUrl, {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${profile.token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		});
	}

	/** @internal */
	protected override response(path: string, init: RequestInit = {}): Promise<Response> {
		return super.response(path, {
			...init,
			redirect: "error",
			signal: init.signal ?? AbortSignal.timeout(30_000),
		});
	}

	/** @internal */
	protected override repositoryPath(owner: string, repo: string): string {
		assertGitHubRepository(this.profile, owner, repo);
		return super.repositoryPath(owner, repo);
	}

	/** @internal */
	async listRepositories() {
		return (
			await this.pages<GitHubRepository>(
				this.profile.allowedOrganization
					? `/orgs/${this.profile.allowedOrganization}/repos?type=all`
					: "/user/repos?affiliation=owner,collaborator,organization_member",
			)
		).filter(
			(repo) =>
				(!this.profile.allowedOrganization ||
					repo.owner.login.toLowerCase() === this.profile.allowedOrganization.toLowerCase()) &&
				!repo.archived &&
				repo.has_issues,
		);
	}
	/** @internal */
	async listOpenIssues(owner: string, repo: string) {
		return (
			await this.pages<
				GitHubIssue & {
					/** @internal */
					pull_request?: unknown;
				}
			>(`${this.repositoryPath(owner, repo)}/issues?state=open`)
		).filter((issue) => !issue.pull_request);
	}
	/** @internal */
	listIssueEvents(owner: string, repo: string, number: number) {
		return this.pages<GitHubLabelEvent>(
			`${this.repositoryPath(owner, repo)}/issues/${number}/events`,
		);
	}
	/** @internal */
	async isOrganizationMember(login: string): Promise<boolean> {
		if (!this.profile.allowedOrganization) return true;
		if (!/^[a-z0-9-]+$/i.test(login)) return false;
		try {
			const response = await this.response(
				`/orgs/${this.profile.allowedOrganization}/members/${encodeURIComponent(login)}`,
			);
			return response.status === 204;
		} catch (error) {
			if (error instanceof IntegrationHttpError) {
				if (error.status === 404) return false;
				throw new Error(`GitHub membership check failed with ${error.status}`);
			}
			throw error;
		}
	}
	/** @internal */
	async authorizedTrigger(
		owner: string,
		repo: string,
		number: number,
		trigger: string,
		done: string,
	) {
		return authorizedTrigger(this, owner, repo, number, trigger, done);
	}
	/** @public */
	async resolveGitIdentity(profile: string): Promise<GitHubGitIdentity> {
		const user = await this.request<{ login: string; name: string | null; id: number }>("/user");
		if (user.login !== this.profile.botLogin)
			throw new Error("GitHub authenticated user does not match bot_login");
		return {
			provider: "github",
			profile,
			login: user.login,
			name: user.name || user.login,
			email: `${user.id}+${user.login}@users.noreply.github.com`,
		};
	}
	/** @public */
	updateIssue(owner: string, repo: string, number: number, patch: Record<string, unknown>) {
		return this.request<GitHubIssue>(`${this.repositoryPath(owner, repo)}/issues/${number}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		});
	}
	/** @internal */
	listLabels(owner: string, repo: string) {
		return this.pages<GitHubLabel>(`${this.repositoryPath(owner, repo)}/labels`);
	}
	/** @internal */
	createLabel(owner: string, repo: string, name: string) {
		return this.request<GitHubLabel>(`${this.repositoryPath(owner, repo)}/labels`, {
			method: "POST",
			body: JSON.stringify({ name, color: "238636" }),
		});
	}
	/** @internal */
	async ensureLabel(owner: string, repo: string, name: string) {
		const labels = await this.listLabels(owner, repo);
		return labels.find((label) => label.name === name) ?? this.createLabel(owner, repo, name);
	}
	/** @internal */
	addFeedbackReaction(owner: string, repo: string, kind: string, id: number) {
		const segment = kind === "inline" ? "pulls/comments" : "issues/comments";
		return this.request(`${this.repositoryPath(owner, repo)}/${segment}/${id}/reactions`, {
			method: "POST",
			body: JSON.stringify({ content: "eyes" }),
		});
	}
	/** @internal */
	async replyFeedback(
		owner: string,
		repo: string,
		pr: number,
		kind: string,
		id: number,
		body: string,
	) {
		if (kind === "inline")
			return this.writeJson(
				`${this.repositoryPath(owner, repo)}/pulls/${pr}/comments/${id}/replies`,
				"POST",
				{ body },
			);
		return this.addIssueComment(owner, repo, pr, body);
	}

	/** @internal */
	getCommit(owner: string, repo: string, ref: string) {
		return this.request<{
			/** @internal */
			sha: string;
		}>(`${this.repositoryPath(owner, repo)}/commits/${encodeURIComponent(ref)}`);
	}

	/** @public */
	async isAncestor(owner: string, repo: string, ancestor: string, descendant: string) {
		const comparison = await this.request<{ status: string }>(
			`${this.repositoryPath(owner, repo)}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}`,
		);
		return comparison.status === "identical" || comparison.status === "ahead";
	}

	/** @public */
	async listPullRequestFeedback(
		owner: string,
		repo: string,
		number: number,
		signal?: AbortSignal,
	): Promise<GitHubFeedbackItem[]> {
		const prefix = `${this.repositoryPath(owner, repo)}`;
		const [conversation, reviews, inline] = await Promise.all([
			this.pages<Record<string, unknown>>(`${prefix}/issues/${number}/comments`, signal),
			this.pages<Record<string, unknown>>(`${prefix}/pulls/${number}/reviews`, signal),
			this.pages<Record<string, unknown>>(`${prefix}/pulls/${number}/comments`, signal),
		]);

		const candidates = [
			...conversation.map((item) => ({ kind: "conversation" as const, item })),
			...reviews.map((item) => ({ kind: "review" as const, item })),
			...inline.map((item) => ({ kind: "inline" as const, item })),
		];
		const feedback: GitHubFeedbackItem[] = [];
		const needsProvenance: typeof candidates = [];
		for (const candidate of candidates) {
			const { kind, item } = candidate;
			const normalized = normalize(kind, item);
			if (!normalized) continue;
			const createdAt = typeof item.created_at === "string" ? Date.parse(item.created_at) : NaN;
			const updatedAt = typeof item.updated_at === "string" ? Date.parse(item.updated_at) : NaN;
			if (
				!this.profile.allowedOrganization ||
				(kind !== "review" && Number.isFinite(createdAt) && createdAt === updatedAt)
			) {
				feedback.push(normalized);
			} else if (typeof item.node_id === "string" && item.node_id) {
				// REST attributes edited bodies to their original author. Reviews also
				// omit edit timestamps, so obtain the body and latest editor together.
				needsProvenance.push(candidate);
			}
		}
		for (let offset = 0; offset < needsProvenance.length; offset += 100) {
			const batch = needsProvenance.slice(offset, offset + 100);
			const response = await this.request<{
				data?: { nodes?: Array<Record<string, unknown> | null> };
				errors?: unknown[];
			}>("/graphql", {
				method: "POST",
				signal,
				body: JSON.stringify({
					query: `query LeitwerkFeedbackProvenance($ids: [ID!]!) {
						nodes(ids: $ids) {
							id __typename
							... on IssueComment { body createdAt lastEditedAt author { login } editor { login } }
							... on PullRequestReview { body createdAt submittedAt lastEditedAt author { login } editor { login } }
							... on PullRequestReviewComment { body createdAt lastEditedAt author { login } editor { login } path line }
						}
					}`,
					variables: { ids: batch.map(({ item }) => item.node_id) },
				}),
			});
			if (response.errors?.length || !Array.isArray(response.data?.nodes)) {
				throw new Error("GitHub feedback provenance lookup failed");
			}
			const snapshots = new Map(
				response.data.nodes.filter((node) => node !== null).map((node) => [node.id, node]),
			);
			for (const { kind, item } of batch) {
				const snapshot = snapshots.get(item.node_id);
				const expectedType = {
					conversation: "IssueComment",
					review: "PullRequestReview",
					inline: "PullRequestReviewComment",
				}[kind];
				if (!snapshot || snapshot.__typename !== expectedType) continue;
				const publishedAt = kind === "review" ? snapshot.submittedAt : snapshot.createdAt;
				if (typeof publishedAt !== "string" || !Number.isFinite(Date.parse(publishedAt))) continue;
				const editedAt = snapshot.lastEditedAt;
				if (editedAt !== null) {
					if (typeof editedAt !== "string" || !Number.isFinite(Date.parse(editedAt))) continue;
					const editor = asUnknownRecord(snapshot.editor)?.login;
					if (typeof editor !== "string" || !(await this.isOrganizationMember(editor))) continue;
				}
				const normalized = normalize(kind, {
					...snapshot,
					id: item.id,
					user: snapshot.author,
					created_at: editedAt ?? publishedAt,
				});
				if (normalized) feedback.push(normalized);
			}
		}
		return feedback;
	}

	/** @public */
	async getCheckSummary(owner: string, repo: string, headSha: string): Promise<GitHubCheckSummary> {
		const runs: Array<Record<string, unknown>> = [];
		for (let page = 1; ; page++) {
			const response = await this.request<{ check_runs: Array<Record<string, unknown>> }>(
				`${this.repositoryPath(owner, repo)}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
			);
			runs.push(...response.check_runs);
			if (response.check_runs.length < 100) break;
		}
		const terminalSuccess = new Set(["success", "neutral", "skipped"]);
		const failed = runs
			.filter((run) => run.status === "completed" && !terminalSuccess.has(String(run.conclusion)))
			.map((run) => ({
				name: String(run.name ?? "unknown"),
				conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
				url: typeof run.html_url === "string" ? run.html_url : null,
			}));
		const pending = runs.some((run) => run.status !== "completed");
		return {
			headSha,
			status: failed.length ? "failure" : pending || !runs.length ? "pending" : "success",
			total: runs.length,
			failed,
		};
	}

	/** Human feedback checked against current membership; delivery receipts use raw reads. */
	/** @internal */
	async listActionablePullRequestFeedback(
		owner: string,
		repo: string,
		number: number,
		signal?: AbortSignal,
	) {
		return actionableFeedback(
			this,
			await this.listPullRequestFeedback(owner, repo, number, signal),
		);
	}

	/** @internal */
	listFeedbackReplies(owner: string, repo: string, pr: number, kind: string) {
		return kind === "inline"
			? this.pages<Record<string, unknown>>(
					`${this.repositoryPath(owner, repo)}/pulls/${pr}/comments`,
				)
			: this.listIssueComments(owner, repo, pr);
	}

	/** @internal */
	listFeedbackReactions(owner: string, repo: string, kind: string, id: number) {
		if (kind !== "inline" && kind !== "conversation")
			throw new Error("Reviews do not support reactions");
		const segment = kind === "inline" ? "pulls/comments" : "issues/comments";
		return this.pages<{
			/** @internal */
			id: number;
			/** @internal */
			content: string;
			/** @internal */
			user: {
				/** @internal */
				login: string;
			};
		}>(`${this.repositoryPath(owner, repo)}/${segment}/${id}/reactions`);
	}

	/** @public */
	async getCiDiagnostics(
		owner: string,
		repo: string,
		pullRequestNumber: number,
		headSha: string,
		signal?: AbortSignal,
	) {
		const pr = await this.getPullRequest(owner, repo, pullRequestNumber, signal);
		if (pr.state !== "open" || pr.merged || pr.head.sha !== headSha)
			throw new Error("CI diagnostics target a stale pull request revision");
		const prefix = this.repositoryPath(owner, repo);
		const checks: Array<{
			/** @internal */
			id: number;
			name: string;
			conclusion: string | null;
			/** @public */
			output?: {
				/** @public */
				title?: string;
				/** @public */
				summary?: string;
				/** @public */
				text?: string;
			};
		}> = [];
		for (let page = 1; ; page++) {
			const batch = await this.request<{ check_runs: typeof checks }>(
				`${prefix}/commits/${encodeURIComponent(headSha)}/check-runs?filter=latest&per_page=100&page=${page}`,
				{ signal },
			);
			checks.push(...batch.check_runs);
			if (batch.check_runs.length < 100) break;
		}
		const failed = checks.filter(
			(c) => c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion),
		);
		const annotations = await Promise.all(
			failed.slice(0, 10).map(async (check) => ({
				/** @public */
				id: check.id,
				/** @public */
				name: check.name,
				/** @public */
				output: check.output,
				/** @public */
				annotations: (
					await this.pages<unknown>(`${prefix}/check-runs/${check.id}/annotations`, signal)
				).slice(0, 100),
			})),
		);
		const jobs: Array<{
			/** @public */
			id: number;
			/** @public */
			name: string;
			/** @public */
			html_url: string;
			/** @public */
			log: {
				/** @public */
				text: string;
				/** @public */
				truncated: boolean;
			};
		}> = [];
		for (let page = 1; jobs.length < 10; page++) {
			const runs = await this.request<{
				workflow_runs: Array<{
					id: number;
					head_sha: string;
					head_branch: string;
					conclusion: string | null;
				}>;
			}>(
				`${prefix}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100&page=${page}`,
				{ signal },
			);
			for (const run of runs.workflow_runs) {
				if (
					run.head_sha !== headSha ||
					run.head_branch !== pr.head.ref ||
					!run.conclusion ||
					["success", "neutral", "skipped"].includes(run.conclusion)
				)
					continue;
				for (let jobPage = 1; jobs.length < 10; jobPage++) {
					const batch = await this.request<{
						jobs: Array<{ id: number; name: string; html_url: string; conclusion: string | null }>;
					}>(`${prefix}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${jobPage}`, {
						signal,
					});
					for (const job of batch.jobs) {
						if (
							!job.conclusion ||
							["success", "neutral", "skipped"].includes(job.conclusion) ||
							jobs.length >= 10
						)
							continue;
						jobs.push({
							id: job.id,
							name: job.name,
							html_url: job.html_url,
							log: await this.readJobLog(owner, repo, job.id, signal),
						});
					}
					if (batch.jobs.length < 100) break;
				}
			}
			if (runs.workflow_runs.length < 100) break;
		}
		const refreshed = await this.getPullRequest(owner, repo, pullRequestNumber, signal);
		if (refreshed.head.sha !== headSha || refreshed.state !== "open" || refreshed.merged)
			throw new Error("CI diagnostics were superseded");
		return {
			/** @public */
			headSha,
			/** @public */
			checks: annotations,
			/** @public */
			jobs,
			/** @public */
			truncated: failed.length > 10 || jobs.length >= 10,
		};
	}
	private async readJobLog(
		owner: string,
		repo: string,
		job: number,
		signal?: AbortSignal,
	): Promise<{ text: string; truncated: boolean }> {
		const timeout = signal
			? AbortSignal.any([signal, AbortSignal.timeout(30000)])
			: AbortSignal.timeout(30000);
		let response = await fetch(
			`${this.profile.apiBaseUrl}${this.repositoryPath(owner, repo)}/actions/jobs/${job}/logs`,
			{
				headers: {
					Authorization: `Bearer ${this.profile.token}`,
					Accept: "application/vnd.github+json",
				},
				redirect: "manual",
				signal: timeout,
			},
		);
		if (response.status === 302) {
			const location = new URL(response.headers.get("location") ?? "");
			if (location.protocol !== "https:" || location.username || location.password)
				throw new Error("Invalid GitHub log download URL");
			await response.body?.cancel();
			// Signed storage URLs must never receive the GitHub credential.
			response = await fetch(location, { redirect: "error", signal: timeout });
		}
		if (!response.ok) throw new IntegrationHttpError(response.status, "GitHub job log unavailable");
		const reader = response.body?.getReader();
		if (!reader) return { text: "", truncated: false };
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		let truncated = false;
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				const part = next.value.slice(0, 65536 - bytes);
				chunks.push(part);
				bytes += part.length;
				if (bytes === 65536) {
					truncated = true;
					break;
				}
			}
		} finally {
			await reader.cancel();
		}
		return { text: Buffer.concat(chunks).toString("utf8"), truncated };
	}

	/** @internal */
	listReleases(owner: string, repo: string) {
		return this.pages<GitHubRelease>(`${this.repositoryPath(owner, repo)}/releases`);
	}

	/** @public */
	downloadReleaseAsset(asset: GitHubRelease["assets"][number]): Promise<string> {
		const url = new URL(asset.url);
		if (`${url.protocol}//${url.host}` !== this.profile.apiBaseUrl)
			throw new Error("GitHub release asset URL does not match the configured API origin");
		return this.response(`${url.pathname}${url.search}`, {
			headers: { Accept: "application/octet-stream" },
		}).then((response) => response.text());
	}
}
