import { createHash } from "node:crypto";
import {
	createWriteIdentity,
	type ExternalWriteLogRepoLike,
	ensureWrite,
	recordWriteIfMissing,
} from "@leitwerk-dev/external-writes";
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

async function reconcile<T>(
	find: () => Promise<T | undefined>,
	create: () => Promise<T>,
): Promise<T> {
	const existing = await find();
	if (existing) return existing;
	try {
		return await create();
	} catch (error) {
		const recovered = await find();
		if (recovered) return recovered;
		throw error;
	}
}
export function registerGitLabDeliveryTools(
	api: ServerExtensionAPI,
	integration: GitLabIntegration,
	writes: ExternalWriteLogRepoLike,
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
			const identity = createWriteIdentity(
				"gitlab.ensure_mr",
				`${binding.projectId}:${project.key}:${workBranch}:${project.baseBranch}`,
			);
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
			let request = await find();
			if (!request) {
				await ensureWrite(
					writes,
					ctx.process.id,
					createWriteIdentity(
						"gitlab.ensure_mr",
						`${binding.projectId}:${project.key}:${project.workBranch}:${project.baseBranch}`,
					),
					async () => {
						request = await reconcile(find, () =>
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
						);
						return { iid: request.iid, url: request.web_url };
					},
				);
				request ??= await find();
			}
			if (!request) throw new Error("GitLab merge request creation could not be reconciled");
			recordWriteIfMissing(writes, ctx.process.id, identity, {
				iid: request.iid,
				url: request.web_url,
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
				writes,
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
				return ensureWrite(writes, ctx.process.id, createWriteIdentity(name, digest), async () => {
					if (name === "gitlab_add_issue_comment") {
						const marker = `<!-- leitwerk:gitlab:issue:${digest} -->`;
						const note = await reconcile(
							async () =>
								(await client.listIssueNotes(b.projectId, iid, ctx.signal)).find((n) =>
									n.body.includes(marker),
								),
							() =>
								client.addIssueNote(
									b.projectId,
									iid,
									`${stringArg(args, "body")}\n\n${marker}`,
									ctx.signal,
								),
						);
						return { noteId: note.id };
					}
					const merged = args.merged === true;
					const trigger = stringArg(args, "triggerLabel");
					const done = stringArg(args, "doneLabel");
					if (merged)
						await reconcile(
							async () =>
								(await client.listLabels(b.projectId, ctx.signal)).find((l) => l.name === done),
							() => client.createLabel(b.projectId, done, ctx.signal),
						);
					const issue = await client.getIssue(b.projectId, iid, ctx.signal);
					const labels = [
						...new Set([...issue.labels.filter((l) => l !== trigger), ...(merged ? [done] : [])]),
					];
					const desired = () =>
						client.updateIssue(
							b.projectId,
							iid,
							{ labels: labels.join(","), ...(merged ? { state_event: "close" as const } : {}) },
							ctx.signal,
						);
					await reconcile(async () => {
						const fresh = await client.getIssue(b.projectId, iid, ctx.signal);
						return !fresh.labels.includes(trigger) &&
							(!merged || (fresh.state === "closed" && fresh.labels.includes(done)))
							? fresh
							: undefined;
					}, desired);
					return { issueIid: iid, merged };
				});
			},
		});
	}
}
