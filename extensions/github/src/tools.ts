import {
	createWriteIdentity,
	type ExternalWriteLogRepoLike,
	ensureWrite,
	recordWriteIfMissing,
} from "@leitwerk-dev/external-writes";
import {
	type IntegrationToolExecutionContext,
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

async function reconcileComment(
	comments: Promise<Array<{ body?: unknown }>>,
	marker: string,
	body: () => string,
	post: (body: string) => Promise<unknown>,
) {
	const existing = (await comments).find((comment) => String(comment.body).includes(marker));
	return existing ?? post(`${body()}\n\n${marker}`);
}

export function registerGitHubTools(
	api: ServerExtensionAPI,
	integration: GitHubIntegration,
	writes: ExternalWriteLogRepoLike,
) {
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
		parameters: {
			type: "object",
			properties: { projectKey: { type: "string" } },
			required: ["projectKey"],
		},
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
	] as const) {
		api.tool({
			name,
			description: "Reconcile GitHub delivery in the current process project",
			parameters: {
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
					typeof input.writeKey === "string" ? stringArg(input, "writeKey") : ctx.idempotencyKey;
				const marker = `<!-- leitwerk-write:${ctx.process.id}:${key} -->`;
				let value: unknown;
				const result = await ensureWrite(
					writes,
					ctx.process.id,
					createWriteIdentity(name, key),
					async () => {
						if (name === "github_ensure_label")
							value = await client.ensureLabel(t.owner, t.repo, stringArg(input, "name"));
						else if (name === "github_update_issue") {
							const issueNumber = numberArg(input, "issueNumber");
							const current = await client.getIssue(t.owner, t.repo, issueNumber);
							const patch = object(input.patch);
							const same = Object.entries(patch).every(
								([key, expected]) =>
									JSON.stringify(
										key === "labels"
											? current.labels.map((label) => label.name).sort()
											: object(current)[key],
									) ===
									JSON.stringify(
										key === "labels" && Array.isArray(expected) ? [...expected].sort() : expected,
									),
							);
							value = same
								? current
								: await client.updateIssue(t.owner, t.repo, issueNumber, patch);
						} else if (name === "github_add_pull_request_feedback_reaction") {
							const kind = stringArg(input, "feedbackKind");
							const id = numberArg(input, "feedbackId");
							const reactions = await client.listFeedbackReactions(t.owner, t.repo, kind, id);
							value =
								reactions.find(
									(reaction) =>
										reaction.content === "eyes" &&
										reaction.user.login.toLowerCase() === client.profile.botLogin.toLowerCase(),
								) ?? (await client.addFeedbackReaction(t.owner, t.repo, kind, id));
						} else {
							const issueNumber = numberArg(
								{ issueNumber: input.issueNumber ?? input.pullRequestNumber },
								"issueNumber",
							);
							value = await reconcileComment(
								name === "github_reply_to_pull_request_feedback"
									? client.listFeedbackReplies(
											t.owner,
											t.repo,
											issueNumber,
											stringArg(input, "feedbackKind"),
										)
									: client.listIssueComments(t.owner, t.repo, issueNumber),
								marker,
								() => stringArg(input, "body"),
								(body) =>
									name === "github_add_issue_comment"
										? client.addIssueComment(t.owner, t.repo, issueNumber, body)
										: client.replyFeedback(
												t.owner,
												t.repo,
												issueNumber,
												stringArg(input, "feedbackKind"),
												numberArg(input, "feedbackId"),
												body,
											),
							);
						}
						return { value };
					},
				);

				if (name === "github_ensure_label") return { name: stringArg(input, "name") };
				return value ?? result;
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
			let pr = await find();
			const identity = createWriteIdentity("github.ensure_pr", ctx.idempotencyKey);
			if (!pr) {
				try {
					await ensureWrite(writes, ctx.process.id, identity, async () => {
						pr = await client.createPullRequest(t.owner, t.repo, {
							title: stringArg(input, "title"),
							body: stringArg(input, "body"),
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
			recordWriteIfMissing(writes, ctx.process.id, identity, {
				number: pr.number,
				url: pr.html_url,
			});
			return pr;
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
	for (const definition of [
		{ name: "github_add_pull_request_comment", update: false },
		{ name: "github_update_pull_request", update: true },
	] as const) {
		api.tool<Record<string, unknown>>({
			name: definition.name,
			description: definition.update
				? "Update a GitHub pull request"
				: "Comment on a GitHub pull request",
			parameters: projectParameters(
				{
					pullRequestNumber: { type: "integer" },
					...(definition.update
						? { patch: { type: "object" } }
						: { body: { type: "string" }, writeKey: { type: "string" } }),
				},
				["pullRequestNumber", definition.update ? "patch" : "body"],
			),
			async execute(ctx, input) {
				const t = target(ctx);
				const pr = numberArg(input, "pullRequestNumber");
				const key =
					!definition.update && typeof input.writeKey === "string"
						? stringArg(input, "writeKey")
						: ctx.idempotencyKey;
				return ensureWrite(
					writes,
					ctx.process.id,
					createWriteIdentity(definition.update ? "github.update_pr" : "github.comment", key),
					async () => {
						if (definition.update)
							await integration
								.client(t.profile)
								.updatePullRequest(t.owner, t.repo, pr, object(input.patch), ctx.signal);
						else {
							const client = integration.client(t.profile);
							await reconcileComment(
								client.listIssueComments(t.owner, t.repo, pr, ctx.signal),
								`<!-- leitwerk-write:${ctx.process.id}:${key} -->`,
								() => stringArg(input, "body"),
								(body) => client.addIssueComment(t.owner, t.repo, pr, body, ctx.signal),
							);
						}
						return { owner: t.owner, repo: t.repo, pullRequestNumber: pr };
					},
				);
			},
		});
	}
}
