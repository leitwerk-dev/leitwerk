import {
	createWriteIdentity,
	type ExternalWriteLogRepoLike,
	ensureWrite,
} from "@leitwerk-dev/external-writes";
import type { ServerExtensionAPI } from "@leitwerk-dev/process-sdk";
import { resolveGitHubProjectBinding } from "./binding.js";
import type { GitHubIntegration } from "./capability.js";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Expected an object");
	return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}

function number(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
		throw new Error(`${name} must be a positive integer`);
	return value;
}

const target = resolveGitHubProjectBinding;

const schema = {
	type: "object",
	properties: {
		projectKey: { type: "string" },
		pullRequestNumber: { type: "integer" },
	},
	required: ["projectKey", "pullRequestNumber"],
} as const;

export function registerGitHubTools(
	api: ServerExtensionAPI,
	integration: GitHubIntegration,
	writes: ExternalWriteLogRepoLike,
) {
	api.tool({
		name: "github_ensure_pull_request",
		description: "Create a GitHub pull request unless the branch pair already has one",
		parameters: {
			type: "object",
			properties: {
				projectKey: { type: "string" },
				title: { type: "string" },
				body: { type: "string" },
				head: { type: "string" },
				base: { type: "string" },
			},
			required: ["projectKey", "title", "body", "head", "base"],
		},
		async execute(ctx, args) {
			const input = object(args);
			const t = target(ctx);
			const client = integration.client(t.profile);
			const head = string(input.head, "head");
			const base = string(input.base, "base");
			const find = async () =>
				(await client.listPullRequests(t.owner, t.repo, "all")).find(
					(candidate) => candidate.head.ref === head && candidate.base.ref === base,
				) ?? null;
			let pr = await find();
			const identity = createWriteIdentity("github.ensure_pr", ctx.idempotencyKey);
			if (!pr) {
				try {
					await ensureWrite(writes, ctx.process.id, identity, async () => {
						pr = await client.createPullRequest(t.owner, t.repo, {
							title: string(input.title, "title"),
							body: string(input.body, "body"),
							head,
							base,
						});
						return { number: pr.number, url: pr.html_url };
					});
				} catch (error) {
					pr = await find();
					if (!pr) throw error;
				}
				pr ??= await find();
			}
			if (!pr) throw new Error("GitHub pull request creation could not be reconciled");
			const confirmed = pr;
			await ensureWrite(writes, ctx.process.id, identity, async () => ({
				number: confirmed.number,
				url: confirmed.html_url,
			}));
			return confirmed;
		},
	});
	api.tool({
		name: "github_get_issue",
		description: "Read a GitHub issue in the current process project",
		parameters: {
			type: "object",
			properties: {
				projectKey: { type: "string" },
				issueNumber: { type: "integer" },
			},
			required: ["projectKey", "issueNumber"],
		},
		async execute(ctx, args) {
			const input = object(args);
			const t = target(ctx);
			return integration
				.client(t.profile)
				.getIssue(t.owner, t.repo, number(input.issueNumber, "issueNumber"), ctx.signal);
		},
	});
	api.tool({
		name: "github_get_pull_request",
		description: "Read a GitHub pull request in the current process project",
		parameters: schema,
		async execute(ctx, args) {
			const input = object(args);
			const t = target(ctx);
			return integration
				.client(t.profile)
				.getPullRequest(
					t.owner,
					t.repo,
					number(input.pullRequestNumber, "pullRequestNumber"),
					ctx.signal,
				);
		},
	});
	api.tool({
		name: "github_list_pull_request_feedback",
		description: "Read GitHub pull request conversation, reviews, and inline comments",
		parameters: schema,
		async execute(ctx, args) {
			const input = object(args);
			const t = target(ctx);
			return integration
				.client(t.profile)
				.listPullRequestFeedback(
					t.owner,
					t.repo,
					number(input.pullRequestNumber, "pullRequestNumber"),
					ctx.signal,
				);
		},
	});
	api.tool({
		name: "github_get_checks",
		description: "Read GitHub Actions check runs for a commit",
		parameters: {
			type: "object",
			properties: {
				projectKey: { type: "string" },
				headSha: { type: "string" },
			},
			required: ["projectKey", "headSha"],
		},
		async execute(ctx, args) {
			const input = object(args);
			const t = target(ctx);
			return integration
				.client(t.profile)
				.getCheckSummary(t.owner, t.repo, string(input.headSha, "headSha"));
		},
	});
	for (const definition of [
		{ name: "github_add_pull_request_comment", update: false },
		{ name: "github_update_pull_request", update: true },
	] as const) {
		api.tool({
			name: definition.name,
			description: definition.update
				? "Update a GitHub pull request"
				: "Comment on a GitHub pull request",
			parameters: {
				...schema,
				properties: {
					...schema.properties,
					...(definition.update
						? { patch: { type: "object" } }
						: { body: { type: "string" }, writeKey: { type: "string" } }),
				},
				required: [...schema.required, definition.update ? "patch" : "body"],
			},
			async execute(ctx, args) {
				const input = object(args);
				const t = target(ctx);
				const pr = number(input.pullRequestNumber, "pullRequestNumber");
				return ensureWrite(
					writes,
					ctx.process.id,
					createWriteIdentity(
						definition.update ? "github.update_pr" : "github.comment",
						!definition.update && typeof input.writeKey === "string"
							? string(input.writeKey, "writeKey")
							: ctx.idempotencyKey,
					),
					async () => {
						if (definition.update)
							await integration
								.client(t.profile)
								.updatePullRequest(t.owner, t.repo, pr, object(input.patch), ctx.signal);
						else
							await integration
								.client(t.profile)
								.addIssueComment(t.owner, t.repo, pr, string(input.body, "body"), ctx.signal);
						return { owner: t.owner, repo: t.repo, pullRequestNumber: pr };
					},
				);
			},
		});
	}
}
