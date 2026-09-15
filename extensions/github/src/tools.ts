import {
	createWriteIdentity,
	type ExternalWriteLogRepoLike,
	ensureWrite,
	recordWriteIfMissing,
} from "@leitwerk-dev/external-writes";
import {
	numberArg,
	objectArg,
	projectParameters,
	type ServerExtensionAPI,
	stringArg,
} from "@leitwerk-dev/process-sdk";
import { resolveGitHubProjectBinding } from "./binding.js";
import type { GitHubIntegration } from "./capability.js";

const object = (value: unknown) => objectArg(value, "Expected an object");

const target = resolveGitHubProjectBinding;

export function registerGitHubTools(
	api: ServerExtensionAPI,
	integration: GitHubIntegration,
	writes: ExternalWriteLogRepoLike,
) {
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
			"listPullRequestFeedback",
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
				return ensureWrite(
					writes,
					ctx.process.id,
					createWriteIdentity(
						definition.update ? "github.update_pr" : "github.comment",
						!definition.update && typeof input.writeKey === "string"
							? stringArg(input, "writeKey")
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
								.addIssueComment(t.owner, t.repo, pr, stringArg(input, "body"), ctx.signal);
						return { owner: t.owner, repo: t.repo, pullRequestNumber: pr };
					},
				);
			},
		});
	}
}
