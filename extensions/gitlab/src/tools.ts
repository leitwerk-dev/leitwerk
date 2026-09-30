import { createHash } from "node:crypto";
import type { ExternalWrites } from "@leitwerk-dev/external-writes";

import {
	type IntegrationToolExecutionContext,
	numberArg,
	projectParameters,
	type ServerExtensionAPI,
	stringArg,
} from "@leitwerk-dev/process-sdk";
import type { GitLabIntegration } from "./capability.js";
import { type GitLabClientLike, GitLabError, observeMergeRequest } from "./client.js";

async function existingRemote<T>(read: () => Promise<T>): Promise<T | null> {
	try {
		return await read();
	} catch (error) {
		if (error instanceof GitLabError && error.status === 404) return null;
		throw error;
	}
}
/** @public */
export function resolveGitLabRepositoryBinding(
	ctx: Pick<IntegrationToolExecutionContext, "project" | "process">,
	integration?: GitLabIntegration,
): {
	/** @public */
	profile: string;
	/** @public */
	projectId: number;
} {
	if (!ctx.project || ctx.project.instanceId !== ctx.process.id)
		throw new Error("An authorized GitLab process project is required");
	const binding = ctx.project.metadata?.gitlab as
		| { profile?: unknown; projectId?: unknown; origin?: unknown }
		| undefined;
	if (
		!binding ||
		typeof binding.profile !== "string" ||
		!binding.profile.trim() ||
		typeof binding.projectId !== "number" ||
		!Number.isSafeInteger(binding.projectId) ||
		binding.projectId <= 0
	)
		throw new Error("Invalid GitLab project binding");
	if (
		binding.origin !== undefined &&
		integration &&
		integration.client(binding.profile).baseUrl !== binding.origin
	)
		throw new Error("GitLab profile installation changed from the pinned repository");
	return { profile: binding.profile, projectId: binding.projectId };
}
/** @public */
export function resolveGitLabBinding(
	ctx: Pick<IntegrationToolExecutionContext, "project" | "process">,
	integration?: GitLabIntegration,
): {
	/** @public */
	profile: string;
	/** @public */
	projectId: number;
	/** @public */
	iid: number;
} {
	const repository = resolveGitLabRepositoryBinding(ctx, integration);
	const iid = (ctx.project?.metadata?.gitlab as { iid?: unknown })?.iid;
	if (typeof iid !== "number" || !Number.isSafeInteger(iid) || iid <= 0)
		throw new Error("Invalid GitLab project binding: a merge request is required");
	return { ...repository, iid };
}
/** Stable marker shared by retry-safe comment creation and later updates. @public */
export function gitLabCommentMarker(input: {
	/** @public */
	baseUrl: string;
	/** @public */
	projectId: number;
	/** @public */
	iid: number;
	/** @public */
	instanceId: string;
	/** @public */
	writeKey: string;
	/** @public */
	discussionId?: string;
}): string {
	const identity: (string | number)[] = [
		input.baseUrl,
		input.projectId,
		input.iid,
		input.instanceId,
		input.writeKey,
	];
	if (input.discussionId) identity.push(input.discussionId);
	return `<!-- leitwerk:gitlab:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")} -->`;
}
/** @internal */
export async function ensureGitLabComment(input: {
	/** @internal */
	client: GitLabClientLike;
	/** @internal */
	writes: ExternalWrites;
	/** @internal */
	instanceId: string;
	/** @internal */
	projectId: number;
	/** @internal */
	iid: number;
	/** @internal */
	writeKey: string;
	/** @internal */
	body: string;
	/** @internal */
	discussionId?: string;
	/** @internal */
	signal?: AbortSignal;
	/** @public */
}): Promise<{
	/** @internal */
	marker: string;
}> {
	const { client, writes, instanceId, projectId, iid, writeKey, signal } = input;
	const marker = gitLabCommentMarker({
		baseUrl: client.baseUrl,
		projectId,
		iid,
		instanceId,
		writeKey,
		discussionId: input.discussionId,
	});
	const digest = marker.slice("<!-- leitwerk:gitlab:".length, -4);
	const find = async () => {
		const notes = input.discussionId
			? (await client.getDiscussion(projectId, iid, input.discussionId, signal)).notes
			: await client.listNotes(projectId, iid, signal);
		return notes.find((note) => note.body.includes(marker));
	};
	await writes.ensure(
		{ writeType: "gitlab.comment", dedupKey: digest },
		{
			reconcile: () => existingRemote(async () => (await find()) ?? null),
			execute: () => {
				const body = `${input.body}\n\n${marker}`;
				return input.discussionId
					? client.replyToDiscussion(projectId, iid, input.discussionId, body, signal)
					: client.addNote(projectId, iid, body, signal);
			},
			toMetadata: (note) => ({ projectId, iid, noteId: note.id, marker }),
		},
	);
	return { marker };
}
/** Idempotently replace a retry-safe top-level comment while retaining its marker. @public */
export async function updateGitLabComment(input: {
	/** @public */
	client: GitLabClientLike;
	/** @public */
	instanceId: string;
	/** @public */
	projectId: number;
	/** @public */
	iid: number;
	/** @public */
	writeKey: string;
	/** @public */
	body: string;
	/** @public */
	signal?: AbortSignal;
}): Promise<{
	/** @public */
	marker: string;
}> {
	const { client, instanceId, projectId, iid, writeKey, body, signal } = input;
	const marker = gitLabCommentMarker({
		baseUrl: client.baseUrl,
		projectId,
		iid,
		instanceId,
		writeKey,
	});
	const note = (await client.listNotes(projectId, iid, signal)).find((item) =>
		item.body.includes(marker),
	);
	if (!note) throw new Error("GitLab comment to update was not found");
	const next = `${body}\n\n${marker}`;
	if (note.body !== next) await client.updateNote(projectId, iid, note.id, next, signal);
	return { marker };
}
/** @internal */
export async function ensureGitLabInlineComment(input: {
	/** @internal */
	client: GitLabClientLike;
	/** @internal */
	writes: ExternalWrites;
	/** @internal */
	instanceId: string;
	/** @internal */
	projectId: number;
	/** @internal */
	iid: number;
	/** @internal */
	writeKey: string;
	/** @internal */
	body: string;
	/** @internal */
	path: string;
	/** @internal */
	line: number;
	/** @internal */
	side: "new" | "old";
	/** @internal */
	baseSha: string;
	/** @internal */
	startSha: string;
	/** @internal */
	headSha: string;
	/** @internal */
	signal?: AbortSignal;
}): Promise<{ marker: string; discussionId: string }> {
	const {
		client,
		writes,
		instanceId,
		projectId,
		iid,
		writeKey,
		body,
		path,
		line,
		side,
		baseSha,
		startSha,
		headSha,
		signal,
	} = input;
	const marker = gitLabCommentMarker({
		baseUrl: client.baseUrl,
		projectId,
		iid,
		instanceId,
		writeKey,
	});
	const digest = marker.slice("<!-- leitwerk:gitlab:".length, -4);
	const find = async () => {
		const discussions = await client.listDiscussions(projectId, iid, signal);
		return discussions.find((discussion) =>
			discussion.notes.some((note) => note.body.includes(marker)),
		);
	};
	const diff = (await client.getChanges(projectId, iid, signal)).find((candidate) =>
		side === "new" ? candidate.new_path === path : candidate.old_path === path,
	);
	if (!diff) throw new Error("GitLab inline comment path is not in the merge request diff");
	await writes.ensure(
		{ writeType: "gitlab.discussion", dedupKey: digest },
		{
			reconcile: () => existingRemote(async () => (await find()) ?? null),
			execute: () =>
				client.addDiscussion(
					projectId,
					iid,
					`${body}\n\n${marker}`,
					{
						position_type: "text",
						base_sha: baseSha,
						start_sha: startSha,
						head_sha: headSha,
						old_path: diff.old_path,
						new_path: diff.new_path,
						...(side === "new" ? { new_line: line } : { old_line: line }),
					},
					signal,
				),
			toMetadata: (discussion) => ({
				projectId,
				iid,
				discussionId: discussion.id,
				marker,
			}),
		},
	);
	const discussion = await find();
	if (!discussion) throw new Error("GitLab inline discussion is unavailable after create");
	return { marker, discussionId: discussion.id };
}
/** @public */
export async function ensureGitLabResolveDiscussion(input: {
	/** @public */
	client: GitLabClientLike;
	/** @public */
	writes: ExternalWrites;
	/** @public */
	instanceId: string;
	/** @internal */
	projectId: number;
	/** @internal */
	iid: number;
	/** @public */
	writeKey: string;
	/** @public */
	discussionId: string;
	/** @public */
	signal?: AbortSignal;
}): Promise<{ discussionId: string; resolved: boolean }> {
	const { client, writes, instanceId, projectId, iid, writeKey, discussionId, signal } = input;
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				client.baseUrl,
				projectId,
				iid,
				instanceId,
				"resolve",
				writeKey,
				discussionId,
			]),
		)
		.digest("hex");
	await writes.ensure(
		{ writeType: "gitlab.discussion.resolve", dedupKey: digest },
		{
			reconcile: () =>
				existingRemote(async () => {
					const discussion = await client.getDiscussion(projectId, iid, discussionId, signal);
					return discussion.notes.some((note) => note.resolved) ? discussion : null;
				}),
			execute: () => client.resolveDiscussion(projectId, iid, discussionId, true, signal),
			toMetadata: () => ({ projectId, iid, discussionId, resolved: true }),
		},
	);
	return { discussionId, resolved: true };
}
/** @public */
export async function ensureGitLabSeenReaction(input: {
	/** @public */
	client: GitLabClientLike;
	/** @public */
	writes: ExternalWrites;
	/** @public */
	instanceId: string;
	/** @internal */
	projectId: number;
	/** @internal */
	iid: number;
	/** @public */
	noteId: number;
	/** @public */
	signal?: AbortSignal;
}): Promise<void> {
	const { client, writes, instanceId, projectId, iid, noteId, signal } = input;
	const digest = createHash("sha256")
		.update(JSON.stringify([client.baseUrl, projectId, iid, instanceId, "eyes", noteId]))
		.digest("hex");
	await writes.ensure(
		{ writeType: "gitlab.reaction", dedupKey: digest },
		{
			reconcile: () =>
				existingRemote(async () => {
					const identity = await client.resolveGitIdentity(signal);
					return (
						(await client.listNoteReactions(projectId, iid, noteId, signal)).find(
							(reaction) =>
								reaction.name === "eyes" && reaction.user.username === identity.username,
						) ?? null
					);
				}),
			execute: () => client.addNoteReaction(projectId, iid, noteId, "eyes", signal),
			toMetadata: (reaction) => ({ projectId, iid, noteId, reactionId: reaction.id, name: "eyes" }),
		},
	);
}
/** @internal */
export function registerGitLabTools(api: ServerExtensionAPI, integration: GitLabIntegration) {
	for (const [name, description, required] of [
		["gitlab_observe_merge_request", "Read the current MR source revision and its latest CI", []],
		["gitlab_get_changes", "Read the MR changes", []],
		["gitlab_get_identity", "Resolve the authenticated GitLab bot Git identity", []],
		["gitlab_list_failed_jobs", "Read failed jobs from an MR-associated pipeline", ["pipelineId"]],
		[
			"gitlab_get_job_trace",
			"Read a bounded trace from a failed MR pipeline job",
			["pipelineId", "jobId"],
		],
		["gitlab_comment", "Post a retry-safe MR comment", ["body", "writeKey"]],
		["gitlab_update_comment", "Update a retry-safe MR comment", ["body", "writeKey"]],
		[
			"gitlab_inline_comment",
			"Post a retry-safe MR inline discussion",
			["body", "writeKey", "path", "line", "side", "baseSha", "startSha", "headSha"],
		],
		[
			"gitlab_reply",
			"Post a retry-safe reply in an MR discussion",
			["body", "writeKey", "discussionId"],
		],
		[
			"gitlab_resolve_discussion",
			"Resolve a retry-safe MR inline discussion",
			["writeKey", "discussionId"],
		],
	] as const) {
		api.tool<Record<string, unknown>>({
			name,
			description,
			parameters: projectParameters(
				{
					pipelineId: { type: "integer" },
					jobId: { type: "integer" },
					maxBytes: { type: "integer" },
					body: { type: "string" },
					writeKey: { type: "string" },
					discussionId: { type: "string" },
					path: { type: "string" },
					line: { type: "integer" },
					side: { type: "string" },
					baseSha: { type: "string" },
					startSha: { type: "string" },
					headSha: { type: "string" },
				},
				[...required],
			),
			async execute(ctx, args) {
				if (name === "gitlab_get_identity")
					return integration
						.client(resolveGitLabRepositoryBinding(ctx, integration).profile)
						.resolveGitIdentity(ctx.signal);
				const b = resolveGitLabBinding(ctx, integration);
				const client = integration.client(b.profile);
				if (name === "gitlab_observe_merge_request")
					return observeMergeRequest(client, b.projectId, b.iid, ctx.signal);
				if (name === "gitlab_get_changes") return client.getChanges(b.projectId, b.iid, ctx.signal);
				if (name === "gitlab_update_comment")
					return updateGitLabComment({
						client,
						instanceId: ctx.process.id,
						projectId: b.projectId,
						iid: b.iid,
						writeKey: stringArg(args, "writeKey"),
						body: stringArg(args, "body"),
						signal: ctx.signal,
					});
				if (name === "gitlab_inline_comment") {
					const side = stringArg(args, "side");
					if (side !== "new" && side !== "old")
						throw new Error("GitLab inline comment side must be new or old");
					return ensureGitLabInlineComment({
						client,
						writes: ctx.externalWrites,
						instanceId: ctx.process.id,
						projectId: b.projectId,
						iid: b.iid,
						writeKey: stringArg(args, "writeKey"),
						body: stringArg(args, "body"),
						path: stringArg(args, "path"),
						line: numberArg(args, "line"),
						side,
						baseSha: stringArg(args, "baseSha"),
						startSha: stringArg(args, "startSha"),
						headSha: stringArg(args, "headSha"),
						signal: ctx.signal,
					});
				}
				if (name === "gitlab_comment" || name === "gitlab_reply")
					return ensureGitLabComment({
						client,
						writes: ctx.externalWrites,
						instanceId: ctx.process.id,
						projectId: b.projectId,
						iid: b.iid,
						writeKey: stringArg(args, "writeKey"),
						body: stringArg(args, "body"),
						...(name === "gitlab_reply" ? { discussionId: stringArg(args, "discussionId") } : {}),
						signal: ctx.signal,
					});
				if (name === "gitlab_resolve_discussion")
					return ensureGitLabResolveDiscussion({
						client,
						writes: ctx.externalWrites,
						instanceId: ctx.process.id,
						projectId: b.projectId,
						iid: b.iid,
						writeKey: stringArg(args, "writeKey"),
						discussionId: stringArg(args, "discussionId"),
						signal: ctx.signal,
					});
				const observation = await observeMergeRequest(client, b.projectId, b.iid, ctx.signal);
				if (!observation.pipeline || observation.pipeline.id !== numberArg(args, "pipelineId"))
					throw new Error("Pipeline is not current for the authorized MR");
				const jobs = await client.listFailedJobs(
					observation.pipeline.project_id,
					observation.pipeline.id,
					ctx.signal,
				);
				if (name === "gitlab_list_failed_jobs") return jobs;
				const job = jobs.find((job) => job.id === numberArg(args, "jobId"));
				if (!job) throw new Error("Job is not a failed job of the authorized MR pipeline");
				return client.getJobTrace(
					observation.pipeline.project_id,
					job.id,
					typeof args.maxBytes === "number" ? args.maxBytes : undefined,
					ctx.signal,
				);
			},
		});
	}
}
