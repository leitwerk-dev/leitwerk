import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type RepositoryFeedbackItem as GitHubFeedbackItem,
	type RepositoryIssue as GitHubIssue,
	type RepositoryPullRequest as GitHubPullRequest,
	IntegrationHttpError,
	normalizeRepositoryFeedback as normalize,
	RepositoryHttpClient,
} from "@leitwerk-dev/process-sdk";

export type { GitHubFeedbackItem, GitHubIssue, GitHubPullRequest };

export interface GitHubRepository {
	name: string;
	full_name: string;
	owner: { login: string };
	ssh_url: string;
	default_branch: string;
	html_url: string;
	archived: boolean;
	has_issues: boolean;
}
export interface GitHubGitIdentity {
	provider: "github";
	profile: string;
	login: string;
	name: string;
	email: string;
}
export interface GitHubLabelEvent {
	id: number;
	event: string;
	label?: { name: string };
	actor: { login: string } | null;
}

export interface GitHubProfile {
	apiBaseUrl: string;
	token: string;
	botLogin: string;
	allowedOrganization?: string;
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

export class GitHubClient extends RepositoryHttpClient {
	constructor(readonly profile: GitHubProfile) {
		super("GitHub", profile.apiBaseUrl, {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${profile.token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		});
	}

	protected override response(path: string, init: RequestInit = {}): Promise<Response> {
		return super.response(path, {
			...init,
			redirect: "error",
			signal: init.signal ?? AbortSignal.timeout(30_000),
		});
	}

	protected override repositoryPath(owner: string, repo: string): string {
		assertGitHubRepository(this.profile, owner, repo);
		return super.repositoryPath(owner, repo);
	}

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
	async listOpenIssues(owner: string, repo: string) {
		return (
			await this.pages<GitHubIssue & { pull_request?: unknown }>(
				`${this.repositoryPath(owner, repo)}/issues?state=open`,
			)
		).filter((issue) => !issue.pull_request);
	}
	listIssueEvents(owner: string, repo: string, number: number) {
		return this.pages<GitHubLabelEvent>(
			`${this.repositoryPath(owner, repo)}/issues/${number}/events`,
		);
	}
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
	async authorizedTrigger(
		owner: string,
		repo: string,
		number: number,
		trigger: string,
		done: string,
	) {
		if (
			this.profile.allowedOrganization &&
			owner.toLowerCase() !== this.profile.allowedOrganization.toLowerCase()
		)
			return null;
		const issue = (await this.getIssue(owner, repo, number)) as GitHubIssue & {
			pull_request?: unknown;
		};
		if (
			issue.pull_request ||
			issue.state !== "open" ||
			!issue.labels.some((l) => l.name === trigger) ||
			issue.labels.some((l) => l.name === done)
		)
			return null;
		const events = await this.listIssueEvents(owner, repo, number);
		const last = events
			.filter(
				(e) => (e.event === "labeled" || e.event === "unlabeled") && e.label?.name === trigger,
			)
			.sort((a, b) => b.id - a.id)[0];
		if (
			last?.event !== "labeled" ||
			!last.actor?.login ||
			!(await this.isOrganizationMember(last.actor.login))
		)
			return null;
		return { issue, actor: last.actor.login, eventId: last.id };
	}
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
	updateIssue(owner: string, repo: string, number: number, patch: Record<string, unknown>) {
		return this.request<GitHubIssue>(`${this.repositoryPath(owner, repo)}/issues/${number}`, {
			method: "PATCH",
			body: JSON.stringify(patch),
		});
	}
	async ensureLabel(owner: string, repo: string, name: string) {
		const labels = await this.pages<{ id: number; name: string }>(
			`${this.repositoryPath(owner, repo)}/labels`,
		);
		return (
			labels.find((label) => label.name === name) ??
			this.request<{ id: number; name: string }>(`${this.repositoryPath(owner, repo)}/labels`, {
				method: "POST",
				body: JSON.stringify({ name, color: "238636" }),
			})
		);
	}
	addFeedbackReaction(owner: string, repo: string, kind: string, id: number) {
		const segment = kind === "inline" ? "pulls/comments" : "issues/comments";
		return this.request(`${this.repositoryPath(owner, repo)}/${segment}/${id}/reactions`, {
			method: "POST",
			body: JSON.stringify({ content: "eyes" }),
		});
	}
	async replyFeedback(
		owner: string,
		repo: string,
		pr: number,
		kind: string,
		id: number,
		body: string,
	) {
		if (kind === "inline")
			return this.request(
				`${this.repositoryPath(owner, repo)}/pulls/${pr}/comments/${id}/replies`,
				{
					method: "POST",
					body: JSON.stringify({ body }),
				},
			);
		return this.addIssueComment(owner, repo, pr, body);
	}

	getCommit(owner: string, repo: string, ref: string) {
		return this.request<{ sha: string }>(
			`${this.repositoryPath(owner, repo)}/commits/${encodeURIComponent(ref)}`,
		);
	}

	async isAncestor(owner: string, repo: string, ancestor: string, descendant: string) {
		const comparison = await this.request<{ status: string }>(
			`${this.repositoryPath(owner, repo)}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(descendant)}`,
		);
		return comparison.status === "identical" || comparison.status === "ahead";
	}

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

		if (!this.profile.allowedOrganization) {
			return [
				...conversation.map((item) => normalize("conversation", item)),
				...reviews.map((item) => normalize("review", item)),
				...inline.map((item) => normalize("inline", item)),
			].filter((item): item is GitHubFeedbackItem => item !== null);
		}
		const candidates: Array<{
			kind: GitHubFeedbackItem["kind"];
			item: Record<string, unknown>;
		}> = [
			...conversation.map((item) => ({ kind: "conversation" as const, item })),
			...reviews.map((item) => ({ kind: "review" as const, item })),
			...inline.map((item) => ({ kind: "inline" as const, item })),
		];
		const feedback: GitHubFeedbackItem[] = [];
		const needsProvenance: typeof candidates = [];
		for (const candidate of candidates) {
			const { kind, item } = candidate;
			if (!normalize(kind, item)) continue;
			const createdAt = typeof item.created_at === "string" ? Date.parse(item.created_at) : NaN;
			const updatedAt = typeof item.updated_at === "string" ? Date.parse(item.updated_at) : NaN;
			if (kind !== "review" && Number.isFinite(createdAt) && createdAt === updatedAt) {
				const normalized = normalize(kind, item);
				if (normalized) feedback.push(normalized);
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
	async listActionablePullRequestFeedback(
		owner: string,
		repo: string,
		number: number,
		signal?: AbortSignal,
	) {
		const feedback = await this.listPullRequestFeedback(owner, repo, number, signal);
		const authorized: GitHubFeedbackItem[] = [];
		for (const item of feedback) {
			if (
				item.author.toLowerCase() === this.profile.botLogin.toLowerCase() ||
				item.body.includes("<!-- leitwerk-write:")
			)
				continue;
			if (await this.isOrganizationMember(item.author)) authorized.push(item);
		}
		return authorized;
	}

	listFeedbackReplies(owner: string, repo: string, pr: number, kind: string) {
		return kind === "inline"
			? this.pages<Record<string, unknown>>(
					`${this.repositoryPath(owner, repo)}/pulls/${pr}/comments`,
				)
			: this.listIssueComments(owner, repo, pr);
	}

	listFeedbackReactions(owner: string, repo: string, kind: string, id: number) {
		if (kind !== "inline" && kind !== "conversation")
			throw new Error("Reviews do not support reactions");
		const segment = kind === "inline" ? "pulls/comments" : "issues/comments";
		return this.pages<{ id: number; content: string; user: { login: string } }>(
			`${this.repositoryPath(owner, repo)}/${segment}/${id}/reactions`,
		);
	}

	listReleases(owner: string, repo: string) {
		return this.pages<GitHubRelease>(`${this.repositoryPath(owner, repo)}/releases`);
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
