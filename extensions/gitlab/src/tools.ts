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
	/** @public */
): {
	/** @public */
	profile: string;
	/** @public */
	projectId: number;
} {
	if (!ctx.project || ctx.project.instanceId !== ctx.process.id)
		throw new Error("An authorized GitLab process project is required");
	const binding = ctx.project.metadata?.gitlab as
		| { profile?: unknown; projectId?: unknown }
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
	return { profile: binding.profile, projectId: binding.projectId };
}
/** @public */
export function resolveGitLabBinding(
	ctx: Pick<IntegrationToolExecutionContext, "project" | "process">,
	/** @public */
): {
	/** @public */
	profile: string;
	/** @public */
	projectId: number;
	/** @public */
	iid: number;
} {
	const repository = resolveGitLabRepositoryBinding(ctx);
	const iid = (ctx.project?.metadata?.gitlab as { iid?: unknown })?.iid;
	if (typeof iid !== "number" || !Number.isSafeInteger(iid) || iid <= 0)
		throw new Error("Invalid GitLab project binding: a merge request is required");
	return { ...repository, iid };
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
	const identity = [client.baseUrl, projectId, iid, instanceId, writeKey];
	if (input.discussionId) identity.push(input.discussionId);
	const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
	const marker = `<!-- leitwerk:gitlab:${digest} -->`;
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
		[
			"gitlab_reply",
			"Post a retry-safe reply in an MR discussion",
			["body", "writeKey", "discussionId"],
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
				},
				[...required],
			),
			async execute(ctx, args) {
				if (name === "gitlab_get_identity")
					return integration
						.client(resolveGitLabRepositoryBinding(ctx).profile)
						.resolveGitIdentity(ctx.signal);
				const b = resolveGitLabBinding(ctx);
				const client = integration.client(b.profile);
				if (name === "gitlab_observe_merge_request")
					return observeMergeRequest(client, b.projectId, b.iid, ctx.signal);
				if (name === "gitlab_get_changes") return client.getChanges(b.projectId, b.iid, ctx.signal);
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
