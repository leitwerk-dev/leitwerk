import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	type RepositoryIssue as ForgejoIssue,
	type RepositoryPullRequest as ForgejoPullRequest,
	normalizeRepositoryFeedback,
	type RepositoryFeedbackItem,
	RepositoryHttpClient,
} from "@leitwerk-dev/process-sdk";

export type { ForgejoIssue, ForgejoPullRequest };

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
	return {
		...enabled,
		defaultLabels: parseLabelNames(rawLabels, "Forgejo ticket_creation.default_labels"),
	};
}

export function parseLabelNames(value: unknown = [], name: string): string[] {
	if (!Array.isArray(value) || value.some((label) => typeof label !== "string" || !label.trim()))
		throw new Error(`${name} must be an array of non-empty strings`);
	return [...new Set(value.map((label) => label.trim()))];
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

function repositoryPath(owner: string, repo: string): string {
	return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

export class ForgejoClient extends RepositoryHttpClient<unknown> {
	protected override repositoryPath = repositoryPath;

	constructor(readonly profile: ForgejoProfile) {
		super(
			"Forgejo",
			`${profile.baseUrl}/api/v1`,
			{
				Accept: "application/json",
				Authorization: `token ${profile.token}`,
			},
			{ key: "limit", size: 50 },
		);
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
			`${repositoryPath(owner, repo)}/issues?state=${encodeURIComponent(state)}&type=issues`,
			signal,
		);
	}

	listOpenIssues(owner: string, repo: string): Promise<ForgejoIssue[]> {
		return this.listIssues(owner, repo, "open");
	}

	async updateIssue(
		owner: string,
		repo: string,
		number: number,
		patch: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<ForgejoIssue> {
		const prefix = `${repositoryPath(owner, repo)}/issues/${number}`;
		const { labels, ...issuePatch } = patch;
		if (labels !== undefined) {
			if (
				!Array.isArray(labels) ||
				labels.some((label) => typeof label !== "number" && typeof label !== "string")
			) {
				throw new Error("Forgejo issue labels must be an array of label ids or names");
			}
			await this.writeJson(`${prefix}/labels`, "PUT", { labels }, signal);
		}
		if (Object.keys(issuePatch).length > 0) {
			return this.writeJson(prefix, "PATCH", issuePatch, signal);
		}
		return this.getIssue(owner, repo, number, signal);
	}

	listLabels(owner: string, repo: string, signal?: AbortSignal): Promise<ForgejoLabel[]> {
		return this.pages(`${repositoryPath(owner, repo)}/labels`, signal);
	}

	createLabel(
		owner: string,
		repo: string,
		name: string,
		color = "2da44e",
		signal?: AbortSignal,
	): Promise<ForgejoLabel> {
		return this.writeJson(`${repositoryPath(owner, repo)}/labels`, "POST", { name, color }, signal);
	}

	createIssue(
		owner: string,
		repo: string,
		input: { title: string; body: string; labels?: readonly number[] },
		signal?: AbortSignal,
	): Promise<ForgejoIssue> {
		return this.writeJson(`${repositoryPath(owner, repo)}/issues`, "POST", input, signal);
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
		return this.writeJson(
			`${repositoryPath(owner, repo)}/issues/comments/${feedback.id}/reactions`,
			"POST",
			{ content },
			signal,
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
		return this.writeJson(
			`${repositoryPath(owner, repo)}/pulls/${pullRequestNumber}/reviews/${feedback.reviewId}/comments`,
			"POST",
			{
				body,
				path: feedback.path,
				new_position: feedback.position ?? feedback.line ?? 0,
				old_position: feedback.originalPosition ?? 0,
				extra_lines_count: feedback.extraLinesCount ?? 0,
			},
			signal,
		);
	}

	async listPullRequestFeedback(
		owner: string,
		repo: string,
		number: number,
		signal?: AbortSignal,
	): Promise<ForgejoFeedbackItem[]> {
		const prefix = repositoryPath(owner, repo);
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
