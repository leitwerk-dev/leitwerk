import { createHash } from "node:crypto";
import {
	numberArg,
	type ProcessProjectRepoLike,
	projectParameters,
	type ServerExtensionAPI,
	stringArg,
} from "@leitwerk-dev/process-sdk";
import type { GitLabIntegration } from "./capability.js";
import {
	ensureGitLabSeenReaction,
	resolveGitLabBinding,
	resolveGitLabRepositoryBinding,
} from "./tools.js";

export function registerGitLabDeliveryTools(
	api: ServerExtensionAPI,
	integration: GitLabIntegration,
	projects: ProcessProjectRepoLike,
) {
	api.tool<Record<string, unknown>>({
		name: "gitlab_ensure_merge_request",
		description: "Create or reconcile and pin the process merge request",
		parameters: projectParameters({ title: { type: "string" }, body: { type: "string" } }, [
			"title",
			"body",
		]),
		async execute(ctx, args) {
			const binding = resolveGitLabRepositoryBinding(ctx);
			const client = integration.client(binding.profile);
			const project = projects.getByInstanceAndKey(ctx.process.id, ctx.project?.key ?? "");
			if (!project?.workBranch || project.workBranch === project.baseBranch)
				throw new Error("A process feature branch is required");
			const workBranch = project.workBranch;
			const identity = {
				writeType: "gitlab.ensure_mr",
				dedupKey: `${binding.projectId}:${project.key}:${workBranch}:${project.baseBranch}`,
			};
			const marker = `<!-- leitwerk:gitlab:merge-request:${ctx.process.id}:${project.key} -->`;
			const find = async () =>
				(
					await client.listBranchMergeRequests(
						binding.projectId,
						workBranch,
						project.baseBranch,
						ctx.signal,
					)
				).find(
					(mr) =>
						mr.source_project_id === binding.projectId &&
						mr.target_project_id === binding.projectId &&
						mr.source_branch === project.workBranch &&
						mr.target_branch === project.baseBranch &&
						mr.description?.includes(marker),
				);
			const request = await ctx.externalWrites.ensure(identity, {
				reconcile: async () => (await find()) ?? null,
				execute: () =>
					client.createMergeRequest(
						binding.projectId,
						{
							title: stringArg(args, "title"),
							description: `${stringArg(args, "body")}\n\n${marker}`,
							source_branch: workBranch,
							target_branch: project.baseBranch,
						},
						ctx.signal,
					),
				toMetadata: (mr) => ({ iid: mr.iid, url: mr.web_url }),
			});
			const latest = projects.getByInstanceAndKey(ctx.process.id, project.key);
			if (
				!latest ||
				latest.workBranch !== project.workBranch ||
				latest.baseBranch !== project.baseBranch
			)
				throw new Error("Process repository binding changed during publication");
			const metadata = latest.metadata ?? {};
			const previous = metadata.gitlab as { iid?: number };
			if (previous.iid && previous.iid !== request.iid)
				throw new Error("Process is already bound to another merge request");
			projects.update(latest.id, {
				metadata: { ...metadata, gitlab: { ...previous, ...binding, iid: request.iid } },
				externalId: String(request.iid),
				externalUrl: request.web_url,
			});
			return request;
		},
	});
	api.tool({
		name: "gitlab_list_merge_request_feedback",
		description: "Read human discussion feedback on the bound merge request",
		parameters: projectParameters(),
		async execute(ctx) {
			const b = resolveGitLabBinding(ctx);
			return integration.client(b.profile).listMergeRequestFeedback(b.projectId, b.iid, ctx.signal);
		},
	});
	api.tool<Record<string, unknown>>({
		name: "gitlab_acknowledge_feedback",
		description: "Reconcile the bot's seen reaction on bound merge request feedback",
		parameters: projectParameters({ noteId: { type: "integer" } }, ["noteId"]),
		async execute(ctx, args) {
			const b = resolveGitLabBinding(ctx);
			const client = integration.client(b.profile);
			const noteId = numberArg(args, "noteId");
			if (
				!(await client.listMergeRequestFeedback(b.projectId, b.iid, ctx.signal)).some(
					(n) => n.id === noteId,
				)
			)
				throw new Error("Note is not actionable feedback on the bound merge request");
			await ensureGitLabSeenReaction({
				client,
				writes: ctx.externalWrites,
				instanceId: ctx.process.id,
				projectId: b.projectId,
				iid: b.iid,
				noteId,
				signal: ctx.signal,
			});
			return { ok: true };
		},
	});
	for (const name of [
		"gitlab_get_issue",
		"gitlab_add_issue_comment",
		"gitlab_finalize_source_issue",
	] as const) {
		api.tool<Record<string, unknown>>({
			name,
			description: "Read or reconcile the process source issue",
			parameters: projectParameters(
				{
					issueNumber: { type: "integer" },
					body: { type: "string" },
					writeKey: { type: "string" },
					merged: { type: "boolean" },
					triggerLabel: { type: "string" },
					doneLabel: { type: "string" },
				},
				["issueNumber"],
			),
			async execute(ctx, args) {
				const b = resolveGitLabRepositoryBinding(ctx);
				const client = integration.client(b.profile);
				const iid = numberArg(args, "issueNumber");
				const bound = (ctx.project?.metadata?.gitlab as { issueIid?: number })?.issueIid;
				if (bound !== iid) throw new Error("Issue does not match the process source issue");
				if (name === "gitlab_get_issue") return client.getIssue(b.projectId, iid, ctx.signal);
				const key = stringArg(args, "writeKey");
				const digest = createHash("sha256")
					.update(JSON.stringify([client.baseUrl, b.projectId, iid, ctx.process.id, key]))
					.digest("hex");
				if (name === "gitlab_add_issue_comment") {
					const marker = `<!-- leitwerk:gitlab:issue:${digest} -->`;
					const note = await ctx.externalWrites.ensure(
						{ writeType: name, dedupKey: digest },
						{
							reconcile: async () =>
								(await client.listIssueNotes(b.projectId, iid, ctx.signal)).find((n) =>
									n.body.includes(marker),
								) ?? null,
							execute: () =>
								client.addIssueNote(
									b.projectId,
									iid,
									`${stringArg(args, "body")}\n\n${marker}`,
									ctx.signal,
								),
							toMetadata: (note) => ({ noteId: note.id }),
						},
					);
					return { noteId: note.id };
				}
				const merged = args.merged === true;
				const trigger = stringArg(args, "triggerLabel");
				const done = stringArg(args, "doneLabel");
				if (merged) {
					await ctx.externalWrites.ensure(
						{
							writeType: "gitlab.ensure_label",
							dedupKey: JSON.stringify([client.baseUrl, b.projectId, done]),
						},
						{
							reconcile: async () =>
								(await client.listLabels(b.projectId, ctx.signal)).find((l) => l.name === done) ??
								null,
							execute: () => client.createLabel(b.projectId, done, ctx.signal),
							toMetadata: (label) => ({ name: label.name }),
						},
					);
				}
				await ctx.externalWrites.ensure(
					{ writeType: name, dedupKey: digest },
					{
						reconcile: async () => {
							const fresh = await client.getIssue(b.projectId, iid, ctx.signal);
							return !fresh.labels.includes(trigger) &&
								(!merged || (fresh.state === "closed" && fresh.labels.includes(done)))
								? fresh
								: null;
						},
						execute: async () => {
							const issue = await client.getIssue(b.projectId, iid, ctx.signal);
							const labels = [
								...new Set([
									...issue.labels.filter((l) => l !== trigger),
									...(merged ? [done] : []),
								]),
							];
							return client.updateIssue(
								b.projectId,
								iid,
								{ labels: labels.join(","), ...(merged ? { state_event: "close" as const } : {}) },
								ctx.signal,
							);
						},
						toMetadata: () => ({ issueIid: iid, merged }),
					},
				);
				return { issueIid: iid, merged };
			},
		});
	}
}
