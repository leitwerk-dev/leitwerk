import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	normalizeRepositoryFeedback,
	type RepositoryFeedbackItem,
} from "@leitwerk-dev/process-sdk";

export interface ForgejoRepository {
	id: number;
	name: string;
	full_name: string;
	ssh_url: string;
	html_url: string;
	default_branch: string;
	archived?: boolean;
	has_issues?: boolean;
	owner: { login: string };
}

export interface ForgejoIssue {
	number: number;
	title: string;
	body: string | null;
	state: string;
	html_url: string;
	updated_at: string;
	user: { login: string };
	labels: Array<{ id: number; name: string }>;
}

export interface ForgejoPullRequest {
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

export interface ForgejoFeedbackItem extends RepositoryFeedbackItem {
	reviewId?: number;
	position?: number;
	originalPosition?: number;
	extraLinesCount?: number;
}

export interface ForgejoLabel {
	id: number;
	name: string;
	color?: string;
}

export interface ForgejoProfile {
	baseUrl: string;
	token: string;
	botLogin: string;
}

export interface ForgejoAuthenticatedUser {
	login: string;
	full_name?: string;
}

export interface ForgejoGitIdentity {
	name: string;
	email: string;
	provider: "forgejo";
	profile: string;
	login: string;
}

export interface ForgejoTicketCreationConfig {
	enabled?: boolean;
	defaultLabels: readonly string[];
}

export function parseForgejoTicketCreationConfig(value: unknown): ForgejoTicketCreationConfig {
	const ticketCreation = asUnknownRecord(asUnknownRecord(value)?.ticket_creation) ?? {};
	const rawLabels = ticketCreation.default_labels;
	if (ticketCreation.enabled !== undefined && typeof ticketCreation.enabled !== "boolean")
		throw new Error("Forgejo ticket_creation.enabled must be a boolean");
	const enabled = ticketCreation.enabled === undefined ? {} : { enabled: ticketCreation.enabled };

	if (rawLabels === undefined) return { ...enabled, defaultLabels: ["created-by-leitwerk"] };
	if (
		!Array.isArray(rawLabels) ||
		rawLabels.some((label) => typeof label !== "string" || label.trim() === "")
	) {
		throw new Error("Forgejo ticket_creation.default_labels must be an array of non-empty strings");
	}
	return { ...enabled, defaultLabels: [...new Set(rawLabels.map((label) => label.trim()))] };
}

export function parseForgejoProfiles(value: unknown): Map<string, ForgejoProfile> {
	const profiles = new Map<string, ForgejoProfile>();
	for (const [name, raw] of Object.entries(
		asUnknownRecord(asUnknownRecord(value)?.profiles) ?? {},
	)) {
		const config = asUnknownRecord(raw) ?? {};
		const baseUrl = typeof config.base_url === "string" ? config.base_url.replace(/\/+$/, "") : "";
		const token = typeof config.token === "string" ? config.token.trim() : "";
		const botLogin = typeof config.bot_login === "string" ? config.bot_login.trim() : "leitwerk";
		if (!/^https:\/\//.test(baseUrl))
			throw new Error(`Forgejo profile '${name}' requires an HTTPS base_url`);
		if (!token) throw new Error(`Forgejo profile '${name}' requires a token`);
		if (!botLogin) throw new Error(`Forgejo profile '${name}' requires bot_login`);
		profiles.set(name, { baseUrl, token, botLogin });
	}
	return profiles;
}

export class ForgejoClient {
	constructor(readonly profile: ForgejoProfile) {}

	private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await fetch(`${this.profile.baseUrl}/api/v1${path}`, {
			...init,
			headers: {
				Accept: "application/json",
				Authorization: `token ${this.profile.token}`,
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
		});
		if (!response.ok) {
			throw new Error(`Forgejo ${init.method ?? "GET"} ${path} failed with ${response.status}`);
		}
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}

	private async pages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
		const items: T[] = [];
		for (let page = 1; ; page++) {
			const separator = path.includes("?") ? "&" : "?";
			const batch = await this.request<T[]>(`${path}${separator}limit=50&page=${page}`, { signal });
			items.push(...batch);
			if (batch.length < 50) return items;
		}
	}

	getAuthenticatedUser(signal?: AbortSignal): Promise<ForgejoAuthenticatedUser> {
		return this.request("/user", { signal });
	}

	async resolveGitIdentity(profile: string, signal?: AbortSignal): Promise<ForgejoGitIdentity> {
		const user = await this.getAuthenticatedUser(signal);
		const login = user.login?.trim();
		if (!login || login !== this.profile.botLogin) {
			throw new Error(`Forgejo profile '${profile}' authenticated as an unexpected user`);
		}
		const fallbackName = login
			.split(/[-_.]+/)
			.filter(Boolean)
			.map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
			.join(" ");
		const name = user.full_name?.trim() || fallbackName;
		const email = `${login}@noreply.${new URL(this.profile.baseUrl).hostname}`;
		return { name, email, provider: "forgejo", profile, login };
	}

	listRepositories(): Promise<ForgejoRepository[]> {
		return this.pages("/user/repos?sort=updated");
	}

	getRepositoryById(id: number, signal?: AbortSignal): Promise<ForgejoRepository> {
		return this.request(`/repositories/${id}`, { signal });
	}

	listIssues(
		owner: string,
		repo: string,
		state = "all",
		signal?: AbortSignal,
	): Promise<ForgejoIssue[]> {
		return this.pages(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${encodeURIComponent(state)}&type=issues`,
			signal,
		);
	}

	listOpenIssues(owner: string, repo: string): Promise<ForgejoIssue[]> {
		return this.listIssues(owner, repo, "open");
	}

	getIssue(
		owner: string,
		repo: string,
		number: number,
		signal?: AbortSignal,
	): Promise<ForgejoIssue> {
		return this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`,
			{ signal },
		);
	}

	listIssueComments(
		owner: string,
		repo: string,
		number: number,
		signal?: AbortSignal,
	): Promise<unknown[]> {
		return this.pages(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
			signal,
		);
	}

	async updateIssue(
		owner: string,
		repo: string,
		number: number,
		patch: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<ForgejoIssue> {
		const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
		const { labels, ...issuePatch } = patch;
		if (labels !== undefined) {
			if (
				!Array.isArray(labels) ||
				labels.some((label) => typeof label !== "number" && typeof label !== "string")
			) {
				throw new Error("Forgejo issue labels must be an array of label ids or names");
			}
			await this.request(`${prefix}/labels`, {
				method: "PUT",
				body: JSON.stringify({ labels }),
				signal,
			});
		}
		if (Object.keys(issuePatch).length > 0) {
			return this.request(prefix, {
				method: "PATCH",
				body: JSON.stringify(issuePatch),
				signal,
			});
		}
		return this.getIssue(owner, repo, number, signal);
	}

	listLabels(owner: string, repo: string, signal?: AbortSignal): Promise<ForgejoLabel[]> {
		return this.pages(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`,
			signal,
		);
	}

	createLabel(
		owner: string,
		repo: string,
		name: string,
		color = "2da44e",
		signal?: AbortSignal,
	): Promise<ForgejoLabel> {
		return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/labels`, {
			method: "POST",
			body: JSON.stringify({ name, color }),
			signal,
		});
	}

	createIssue(
		owner: string,
		repo: string,
		input: { title: string; body: string; labels?: readonly number[] },
		signal?: AbortSignal,
	): Promise<ForgejoIssue> {
		return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
			method: "POST",
			body: JSON.stringify(input),
			signal,
		});
	}

	addIssueComment(
		owner: string,
		repo: string,
		number: number,
		body: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}/comments`,
			{ method: "POST", body: JSON.stringify({ body }), signal },
		);
	}

	createPullRequest(
		owner: string,
		repo: string,
		input: { title: string; body: string; head: string; base: string },
	): Promise<ForgejoPullRequest> {
		return this.request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
			method: "POST",
			body: JSON.stringify(input),
		});
	}

	getPullRequest(
		owner: string,
		repo: string,
		number: number,
		signal?: AbortSignal,
	): Promise<ForgejoPullRequest> {
		return this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
			{ signal },
		);
	}

	listPullRequests(owner: string, repo: string, state = "open"): Promise<ForgejoPullRequest[]> {
		return this.pages(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${encodeURIComponent(state)}`,
		);
	}

	updatePullRequest(
		owner: string,
		repo: string,
		number: number,
		patch: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<ForgejoPullRequest> {
		return this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
			{ method: "PATCH", body: JSON.stringify(patch), signal },
		);
	}

	addPullRequestComment(
		owner: string,
		repo: string,
		number: number,
		body: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		return this.addIssueComment(owner, repo, number, body, signal);
	}

	addPullRequestFeedbackReaction(
		owner: string,
		repo: string,
		feedback: Pick<ForgejoFeedbackItem, "kind" | "id">,
		content: "eyes",
		signal?: AbortSignal,
	): Promise<unknown> {
		if (feedback.kind === "review") {
			throw new Error("Forgejo does not expose reactions for submitted reviews");
		}
		return this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${feedback.id}/reactions`,
			{ method: "POST", body: JSON.stringify({ content }), signal },
		);
	}

	replyToPullRequestFeedback(
		owner: string,
		repo: string,
		pullRequestNumber: number,
		feedback: ForgejoFeedbackItem,
		body: string,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (feedback.kind !== "inline" || !feedback.reviewId || !feedback.path) {
			return this.addPullRequestComment(owner, repo, pullRequestNumber, body, signal);
		}
		return this.request(
			`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullRequestNumber}/reviews/${feedback.reviewId}/comments`,
			{
				method: "POST",
				body: JSON.stringify({
					body,
					path: feedback.path,
					new_position: feedback.position ?? feedback.line ?? 0,
					old_position: feedback.originalPosition ?? 0,
					extra_lines_count: feedback.extraLinesCount ?? 0,
				}),
				signal,
			},
		);
	}

	async listPullRequestFeedback(
		owner: string,
		repo: string,
		number: number,
		signal?: AbortSignal,
	): Promise<ForgejoFeedbackItem[]> {
		const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
		const [conversation, reviews] = await Promise.all([
			this.pages<Record<string, unknown>>(`${prefix}/issues/${number}/comments`, signal),
			this.pages<Record<string, unknown>>(`${prefix}/pulls/${number}/reviews`, signal),
		]);
		const inline = (
			await Promise.all(
				reviews
					.filter((review) => typeof review.id === "number")
					.map(async (review) =>
						(
							await this.pages<Record<string, unknown>>(
								`${prefix}/pulls/${number}/reviews/${String(review.id)}/comments`,
								signal,
							)
						).map((comment) => ({ ...comment, reviewId: review.id })),
					),
			)
		).flat();
		const normalize = (
			kind: ForgejoFeedbackItem["kind"],
			item: Record<string, unknown>,
		): ForgejoFeedbackItem | null => {
			const feedback = normalizeRepositoryFeedback(kind, item);
			if (!feedback) return null;
			return {
				...feedback,
				...(typeof item.reviewId === "number" ? { reviewId: item.reviewId } : {}),
				...(typeof item.position === "number" ? { position: item.position } : {}),
				...(typeof item.original_position === "number"
					? { originalPosition: item.original_position }
					: {}),
				...(typeof item.extra_lines_count === "number"
					? { extraLinesCount: item.extra_lines_count }
					: {}),
			};
		};
		return [
			...conversation.map((item) => normalize("conversation", item)),
			...reviews.map((item) => normalize("review", item)),
			...inline.map((item) => normalize("inline", item)),
		].filter((item): item is ForgejoFeedbackItem => item !== null);
	}
}
