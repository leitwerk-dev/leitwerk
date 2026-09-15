import { createHash } from "node:crypto";
import {
	createWriteIdentity,
	type ExternalWriteLogRepoLike,
	ensureWrite,
} from "@leitwerk-dev/external-writes";
import {
	type IntegrationToolExecutionContext,
	numberArg,
	projectParameters,
	type ServerExtensionAPI,
	stringArg,
} from "@leitwerk-dev/process-sdk";
import type { GitLabIntegration } from "./capability.js";
import { type GitLabClientLike, observeMergeRequest } from "./client.js";
export function resolveGitLabBinding(
	ctx: Pick<IntegrationToolExecutionContext, "project" | "process">,
): { profile: string; projectId: number; iid: number } {
	if (!ctx.project || ctx.project.instanceId !== ctx.process.id)
		throw new Error("An authorized GitLab process project is required");
	const binding = ctx.project.metadata?.gitlab as
		| { profile?: unknown; projectId?: unknown; iid?: unknown }
		| undefined;
	if (
		!binding ||
		typeof binding.profile !== "string" ||
		typeof binding.projectId !== "number" ||
		typeof binding.iid !== "number"
	)
		throw new Error("Invalid GitLab project binding");
	return { profile: binding.profile, projectId: binding.projectId, iid: binding.iid };
}
export async function ensureGitLabComment(input: {
	client: GitLabClientLike;
	writes: ExternalWriteLogRepoLike;
	instanceId: string;
	projectId: number;
	iid: number;
	writeKey: string;
	body: string;
	signal?: AbortSignal;
}): Promise<{ marker: string }> {
	const { client, writes, instanceId, projectId, iid, writeKey, signal } = input;
	const digest = createHash("sha256")
		.update(JSON.stringify([client.baseUrl, projectId, iid, instanceId, writeKey]))
		.digest("hex");
	const marker = `<!-- leitwerk:gitlab:${digest} -->`;
	const find = async () =>
		(await client.listNotes(projectId, iid, signal)).find((note) => note.body.includes(marker));
	await ensureWrite(writes, instanceId, createWriteIdentity("gitlab.comment", digest), async () => {
		let note = await find();
		if (!note) {
			try {
				note = await client.addNote(projectId, iid, `${input.body}\n\n${marker}`, signal);
			} catch (error) {
				note = await find();
				if (!note) throw error;
			}
		}
		return { projectId, iid, noteId: note.id, marker };
	});
	return { marker };
}
export function registerGitLabTools(
	api: ServerExtensionAPI,
	integration: GitLabIntegration,
	writes: ExternalWriteLogRepoLike,
) {
	for (const name of [
		"gitlab_observe_merge_request",
		"gitlab_get_changes",
		"gitlab_get_identity",
		"gitlab_list_failed_jobs",
		"gitlab_get_job_trace",
		"gitlab_comment",
	] as const) {
		api.tool<Record<string, unknown>>({
			name,
			description: {
				gitlab_observe_merge_request: "Read the current MR source revision and its latest CI",
				gitlab_get_changes: "Read the MR changes",
				gitlab_get_identity: "Resolve the authenticated GitLab bot Git identity",
				gitlab_list_failed_jobs: "Read failed jobs from an MR-associated pipeline",
				gitlab_get_job_trace: "Read a bounded trace from a failed MR pipeline job",
				gitlab_comment: "Post a retry-safe MR comment",
			}[name],
			parameters: projectParameters(
				{
					pipelineId: { type: "integer" },
					jobId: { type: "integer" },
					maxBytes: { type: "integer" },
					body: { type: "string" },
					writeKey: { type: "string" },
				},
				name === "gitlab_comment"
					? ["body", "writeKey"]
					: name === "gitlab_get_job_trace"
						? ["pipelineId", "jobId"]
						: name === "gitlab_list_failed_jobs"
							? ["pipelineId"]
							: [],
			),
			async execute(ctx, args) {
				const b = resolveGitLabBinding(ctx);
				const client = integration.client(b.profile);
				if (name === "gitlab_observe_merge_request")
					return observeMergeRequest(client, b.projectId, b.iid, ctx.signal);
				if (name === "gitlab_get_changes") return client.getChanges(b.projectId, b.iid, ctx.signal);
				if (name === "gitlab_get_identity") return client.resolveGitIdentity(ctx.signal);
				if (name === "gitlab_comment")
					return ensureGitLabComment({
						client,
						writes,
						instanceId: ctx.process.id,
						projectId: b.projectId,
						iid: b.iid,
						writeKey: stringArg(args, "writeKey"),
						body: stringArg(args, "body"),
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
