import {
	existingObject,
	type IntegrationToolExecutionContext,
	matchesPatch,
	numberArg,
	objectArg,
	projectParameters,
	type ServerExtensionAPI,
	stringArg,
} from "@leitwerk-dev/process-sdk";
import { resolveGitHubProjectBinding } from "./binding.js";
import type { GitHubIntegration } from "./capability.js";
import { assertGitHubRepository } from "./client.js";

const object = (value: unknown) => objectArg(value, "Expected an object");

export function registerGitHubTools(api: ServerExtensionAPI, integration: GitHubIntegration) {
	const target = (ctx: IntegrationToolExecutionContext) => {
		const binding = resolveGitHubProjectBinding(ctx);
		assertGitHubRepository(
			integration.client(binding.profile).profile,
			binding.owner,
			binding.repo,
		);
		return binding;
	};
	api.tool({
		name: "github_resolve_git_identity",
		description: "Resolve the configured GitHub Git identity",
		parameters: projectParameters(),
		async execute(ctx) {
			const t = target(ctx);
			return integration.client(t.profile).resolveGitIdentity(t.profile);
		},
	});
	for (const name of [
		"github_ensure_label",
		"github_update_issue",
		"github_add_issue_comment",
		"github_add_pull_request_feedback_reaction",
		"github_reply_to_pull_request_feedback",
		"github_add_pull_request_comment",
		"github_update_pull_request",
	] as const) {
		const pullRequest =
			name === "github_add_pull_request_comment" || name === "github_update_pull_request";
		const update = name === "github_update_issue" || name === "github_update_pull_request";
		api.tool({
			name,
			description: pullRequest
				? update
					? "Update a GitHub pull request"
					: "Comment on a GitHub pull request"
				: "Reconcile GitHub delivery in the current process project",
			parameters: pullRequest
				? projectParameters(
						{
							pullRequestNumber: { type: "integer" },
							...(update
								? { patch: { type: "object" } }
								: { body: { type: "string" }, writeKey: { type: "string" } }),
						},
						["pullRequestNumber", update ? "patch" : "body"],
					)
				: {
						type: "object",
						properties: {
							projectKey: { type: "string" },
							issueNumber: { type: "integer" },
							pullRequestNumber: { type: "integer" },
							name: { type: "string" },
							patch: { type: "object" },
							body: { type: "string" },
							feedbackKind: { type: "string" },
							feedbackId: { type: "integer" },
							writeKey: { type: "string" },
						},
						required: ["projectKey"],
					},
			async execute(ctx, args) {
				const input = object(args);
				const t = target(ctx);
				const client = integration.client(t.profile);
				const key =
					!(pullRequest && update) && typeof input.writeKey === "string"
						? stringArg(input, "writeKey")
						: ctx.idempotencyKey;
				const signal = pullRequest ? ctx.signal : undefined;
				const marker = `<!-- leitwerk-write:${ctx.process.id}:${key} -->`;
				const issueNumber = () =>
					numberArg(
						input,
						pullRequest || input.issueNumber == null ? "pullRequestNumber" : "issueNumber",
					);
				const findComment = async () => {
					const replies =
						name === "github_reply_to_pull_request_feedback"
							? await client.listFeedbackReplies(
									t.owner,
									t.repo,
									issueNumber(),
									stringArg(input, "feedbackKind"),
								)
							: await client.listIssueComments(t.owner, t.repo, issueNumber(), signal);
					return (
						replies.find(
							(comment) =>
								String(comment.body).includes(marker) &&
								(name !== "github_reply_to_pull_request_feedback" ||
									input.feedbackKind !== "inline" ||
									object(comment).in_reply_to_id === numberArg(input, "feedbackId")),
						) ?? null
					);
				};
				const result = await ctx.externalWrites.ensure(
					{
						writeType: pullRequest ? (update ? "github.update_pr" : "github.comment") : name,
						dedupKey: key,
					},
					{
						reconcile: async (phase): Promise<object | null> =>
							existingObject(async () => {
								if (name === "github_ensure_label")
									return (
										(await client.listLabels(t.owner, t.repo)).find(
											(label) => label.name === stringArg(input, "name"),
										) ?? null
									);
								if (update) {
									const current = await client[pullRequest ? "getPullRequest" : "getIssue"](
										t.owner,
										t.repo,
										issueNumber(),
										signal,
									);
									return current &&
										(phase === "already_recorded" || matchesPatch(current, object(input.patch)))
										? current
										: null;
								}
								if (name === "github_add_pull_request_feedback_reaction")
									return (
										(
											await client.listFeedbackReactions(
												t.owner,
												t.repo,
												stringArg(input, "feedbackKind"),
												numberArg(input, "feedbackId"),
											)
										).find(
											(reaction) =>
												reaction.content === "eyes" &&
												reaction.user.login.toLowerCase() === client.profile.botLogin.toLowerCase(),
										) ?? null
									);
								return findComment();
							}),
						execute: async (): Promise<object> => {
							if (name === "github_ensure_label")
								return client.createLabel(t.owner, t.repo, stringArg(input, "name"));
							if (update)
								return pullRequest
									? object(
											await client.updatePullRequest(
												t.owner,
												t.repo,
												issueNumber(),
												object(input.patch),
												signal,
											),
										)
									: client.updateIssue(t.owner, t.repo, issueNumber(), object(input.patch));
							if (name === "github_add_pull_request_feedback_reaction")
								return object(
									await client.addFeedbackReaction(
										t.owner,
										t.repo,
										stringArg(input, "feedbackKind"),
										numberArg(input, "feedbackId"),
									),
								);
							const body = `${stringArg(input, "body")}\n\n${marker}`;
							return object(
								await (name === "github_add_issue_comment" || pullRequest
									? client.addIssueComment(t.owner, t.repo, issueNumber(), body, signal)
									: client.replyFeedback(
											t.owner,
											t.repo,
											issueNumber(),
											stringArg(input, "feedbackKind"),
											numberArg(input, "feedbackId"),
											body,
										)),
							);
						},
						toMetadata: (value) =>
							pullRequest
								? { owner: t.owner, repo: t.repo, pullRequestNumber: issueNumber() }
								: { value },
					},
				);
				if (name === "github_ensure_label") return { name: stringArg(input, "name") };
				return result;
			},
		});
	}

	api.tool<Record<string, unknown>>({
		name: "github_ensure_pull_request",
		description: "Create a GitHub pull request unless the branch pair already has one",
		parameters: projectParameters({
			title: { type: "string" },
			body: { type: "string" },
			head: { type: "string" },
			base: { type: "string" },
		}),
		async execute(ctx, input) {
			const t = target(ctx);
			const client = integration.client(t.profile);
			const head = stringArg(input, "head");
			const base = stringArg(input, "base");
			if (head !== ctx.project?.workBranch || base !== ctx.project?.baseBranch)
				throw new Error("Pull request branches must match the process project");
			const find = async () =>
				(await client.listPullRequests(t.owner, t.repo, "all")).find(
					(candidate) => candidate.head.ref === head && candidate.base.ref === base,
				) ?? null;
			return ctx.externalWrites.ensure(
				{ writeType: "github.ensure_pr", dedupKey: ctx.idempotencyKey },
				{
					reconcile: () => existingObject(find),
					execute: () =>
						client.createPullRequest(t.owner, t.repo, {
							title: stringArg(input, "title"),
							body: stringArg(input, "body"),
							head,
							base,
						}),
					toMetadata: (pr) => ({ number: pr.number, url: pr.html_url }),
				},
			);
		},
	});
	for (const [name, description, numberName, method] of [
		[
			"github_get_issue",
			"Read a GitHub issue in the current process project",
			"issueNumber",
			"getIssue",
		],
		[
			"github_get_pull_request",
			"Read a GitHub pull request in the current process project",
			"pullRequestNumber",
			"getPullRequest",
		],
		[
			"github_list_pull_request_feedback",
			"Read GitHub pull request conversation, reviews, and inline comments",
			"pullRequestNumber",
			"listActionablePullRequestFeedback",
		],
	] as const) {
		api.tool<Record<string, unknown>>({
			name,
			description,
			parameters: projectParameters({ [numberName]: { type: "integer" } }),
			async execute(ctx, input) {
				const t = target(ctx);
				return integration
					.client(t.profile)
					[method](t.owner, t.repo, numberArg(input, numberName), ctx.signal);
			},
		});
	}
	api.tool<Record<string, unknown>>({
		name: "github_get_checks",
		description: "Read GitHub Actions check runs for a commit",
		parameters: projectParameters({ headSha: { type: "string" } }),
		async execute(ctx, input) {
			const t = target(ctx);
			return integration
				.client(t.profile)
				.getCheckSummary(t.owner, t.repo, stringArg(input, "headSha"));
		},
	});
}
