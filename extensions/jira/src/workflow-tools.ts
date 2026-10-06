import { createHash } from "node:crypto";
import { basename } from "node:path";
import { asUnknownRecord } from "@leitwerk-dev/domain";
import {
	coreHostCapabilities,
	type IntegrationToolExecutionContext,
	projectParameters,
	type ServerExtensionAPI,
	stringArg,
} from "@leitwerk-dev/process-sdk";
import type { JiraIntegration } from "./index.js";

/** @internal */
export function resolveJiraSourceClient(
	ctx: IntegrationToolExecutionContext,
	integration: JiraIntegration,
) {
	const binding = asUnknownRecord(ctx.project?.metadata?.jira);
	if (
		typeof binding?.profile !== "string" ||
		typeof binding.issueId !== "string" ||
		typeof binding.baseUrl !== "string"
	)
		throw new Error("Missing Jira source binding");
	const client = integration.client(binding.profile);
	if (client.baseUrl !== binding.baseUrl) throw new Error("Jira profile installation changed");
	return { client, id: binding.issueId, binding };
}

const digest = (parts: unknown[]) =>
	createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const statusName = (name: string | undefined) => name?.trim().toLowerCase();

/** @internal */
export function registerJiraWorkflowTools(api: ServerExtensionAPI, integration: JiraIntegration) {
	api.tool<Record<string, unknown>>({
		name: "jira_ensure_remote_link",
		description: "Link the current Leitwerk process or its pinned merge request to the Jira source",
		parameters: projectParameters(
			{ kind: { type: "string", enum: ["process", "merge_request"] } },
			["kind"],
		),
		async execute(ctx, args) {
			const { client, id } = resolveJiraSourceClient(ctx, integration);
			const kind = stringArg(args, "kind");
			let url: string;
			let title: string;
			let target: string;
			if (kind === "process") {
				const deps = api.get?.(coreHostCapabilities.serverSetup);
				const serverBaseUrl = deps && !Array.isArray(deps) ? deps.serverBaseUrl : undefined;
				if (!serverBaseUrl) throw new Error("Leitwerk public server URL is unavailable");
				url = `${serverBaseUrl.replace(/\/+$/, "")}/processes/${encodeURIComponent(ctx.process.id)}`;
				title = `Leitwerk process ${ctx.process.id}`;
				target = ctx.process.id;
			} else if (kind === "merge_request") {
				const mr = asUnknownRecord(ctx.project?.metadata?.gitlab);
				if (
					!ctx.project?.externalUrl ||
					!ctx.project.externalId ||
					typeof mr?.iid !== "number" ||
					String(mr.iid) !== ctx.project.externalId
				)
					throw new Error("A pinned merge request is required for the Jira link");
				url = ctx.project.externalUrl;
				const repositoryName = basename(ctx.project.repoLocator).replace(/\.git$/, "");
				title = `GitLab ${repositoryName} !${ctx.project.externalId}`;
				target = JSON.stringify([ctx.project.id, ctx.project.externalId]);
			} else throw new Error("Unknown Jira remote link kind");
			const key = digest([client.baseUrl, id, kind, target]);
			const globalId = `leitwerk:${key}`;
			const intended = { globalId, object: { url, title } };
			const find = async () =>
				(await client.listRemoteLinks(id, ctx.signal)).find((link) => link.globalId === globalId) ??
				null;
			const link = await ctx.externalWrites.ensure(
				{ writeType: "jira.remote_link", dedupKey: key },
				{
					reconcile: async (phase) => {
						const link = await find();
						return link &&
							(phase === "already_recorded" ||
								(link.object.url === url && link.object.title === title))
							? link
							: null;
					},
					execute: async () => {
						await client.upsertRemoteLink(id, intended, ctx.signal);
						const link = await find();
						if (!link || link.object.url !== url || link.object.title !== title)
							throw new Error("Jira remote link read-back did not match");
						return link;
					},
					toMetadata: (link) => ({ linkId: link.id, globalId: link.globalId }),
				},
			);
			return { linkId: link.id, url };
		},
	});
	api.tool<Record<string, unknown>>({
		name: "jira_transition_source_issue",
		description: "Reconcile the Jira source ticket's work or review status",
		parameters: projectParameters(
			{ targetStatus: { type: "string", enum: ["In Progress", "In Review"] } },
			["targetStatus"],
		),
		async execute(ctx, args) {
			const { client, id } = resolveJiraSourceClient(ctx, integration);
			const targetStatus = stringArg(args, "targetStatus");
			if (!["In Progress", "In Review"].includes(targetStatus))
				throw new Error("Unsupported Jira workflow target status");
			const target = statusName(targetStatus);
			const reconcile = async (phase: string) => {
				const { status } = (await client.getIssue(id, ctx.signal)).fields;
				return phase === "already_recorded" ||
					statusName(status.name) === target ||
					status.statusCategory.key === "done" ||
					(target === "in progress" && statusName(status.name) === "in review")
					? { issueId: id, status: status.name ?? status.statusCategory.key }
					: null;
			};
			return ctx.externalWrites.ensure(
				{
					writeType: "jira.transition",
					dedupKey: digest([client.baseUrl, id, ctx.process.id, target]),
				},
				{
					reconcile,
					execute: async () => {
						const current = await reconcile("before_execute");
						if (current) return current;
						const transitions = (await client.listTransitions(id, ctx.signal)).filter(
							(transition) => statusName(transition.to.name) === target,
						);
						if (transitions.length !== 1)
							throw new Error(
								`Jira requires one available transition to ${targetStatus}; found ${transitions.length}`,
							);
						await client.transitionIssue(id, transitions[0].id, ctx.signal);
						const result = await reconcile("after_execute_error");
						if (!result) throw new Error(`Jira did not reach ${targetStatus}`);
						return result;
					},
					toMetadata: (result) => result,
				},
			);
		},
	});
}
