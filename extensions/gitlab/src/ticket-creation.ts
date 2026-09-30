import {
	numberArg,
	objectArg,
	parseTicketDestinationId,
	type ServerExtensionAPI,
	stringArg,
	type TicketCreationConfig,
	type TicketCreationDestinationProvider,
	type TicketCreationDestinationSnapshot,
	ticketDestinationId,
	ticketLabelNames,
} from "@leitwerk-dev/process-sdk";
import type { GitLabIntegration } from "./capability.js";
import type { GitLabProject } from "./client.js";

function available(project: GitLabProject): boolean {
	return (
		!project.archived &&
		project.issues_enabled !== false &&
		project.issues_access_level !== "disabled"
	);
}

function destinationData(snapshot: TicketCreationDestinationSnapshot) {
	const data = objectArg(snapshot.data);
	return {
		profile: stringArg(data, "profile"),
		baseUrl: stringArg(data, "baseUrl"),
		projectId: numberArg(data, "projectId"),
		path: stringArg(data, "path"),
		defaultLabels: ticketLabelNames(data.defaultLabels),
	};
}

/** @internal */
export function registerGitLabTicketCreation(
	api: ServerExtensionAPI,
	integration: GitLabIntegration,
	config: TicketCreationConfig,
): void {
	if (!config.enabled) return;
	const summary = (profile: string, project: GitLabProject) => ({
		id: ticketDestinationId(profile, project.id),
		displayName: project.path_with_namespace,
		group: `${profile} · ${new URL(integration.client(profile).baseUrl).hostname}`,
		description: config.defaultLabels.length
			? `Default labels: ${config.defaultLabels.join(", ")}`
			: "No default labels",
	});
	const destinations: TicketCreationDestinationProvider = {
		async list() {
			const results = await Promise.all(
				integration.profiles().map(async (profile) => {
					try {
						const projects = await integration.client(profile).listProjects();
						return {
							destinations: projects.filter(available).map((project) => summary(profile, project)),
							warnings: [],
						};
					} catch {
						return {
							destinations: [],
							warnings: [`GitLab profile '${profile}' is currently unavailable.`],
						};
					}
				}),
			);
			return {
				destinations: results.flatMap((result) => result.destinations),
				warnings: results.flatMap((result) => result.warnings),
			};
		},
		async resolve({ destinationId }) {
			const { profile, resourceId } = parseTicketDestinationId(destinationId);
			const client = integration.client(profile);
			const project = await client.getProject(Number(resourceId));
			if (!available(project)) throw new Error("The selected GitLab project cannot accept issues");
			const labels = await client.listLabels(project.id);
			return {
				summary: summary(profile, project),
				data: {
					profile,
					baseUrl: client.baseUrl,
					projectId: project.id,
					path: project.path_with_namespace,
					defaultLabels: config.defaultLabels,
				},
				agentContext: `Create an issue in ${project.path_with_namespace}. Existing optional labels: ${labels.map((label) => label.name).join(", ") || "none"}.`,
			};
		},
		async validate(snapshot) {
			const data = destinationData(snapshot);
			const client = integration.client(data.profile);
			if (client.baseUrl !== data.baseUrl) throw new Error("GitLab profile installation changed");
			const project = await client.getProject(data.projectId);
			if (!available(project) || project.path_with_namespace !== data.path)
				throw new Error("The selected GitLab project changed; choose the destination again");
		},
	};
	api.tool<Record<string, unknown>>({
		name: "gitlab_create_issue",
		description: "Create one issue in the selected GitLab project",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "Concise issue title" },
				description: { type: "string", description: "Complete Markdown issue description" },
				labels: {
					type: "array",
					items: { type: "string" },
					description: "Optional existing label names",
				},
			},
			required: ["title", "description"],
		},
		capability: {
			kind: "ticket_creation",
			displayName: "GitLab",
			processId: "ticket_creation_process",
			startTurnId: "create_ticket",
			titlePath: "/title",
			descriptionPath: "/description",
			descriptionFormat: "markdown",
			destinations,
		},
		async execute(ctx, args) {
			if (!ctx.ticketDestination) throw new Error("A GitLab ticket destination is required");
			await destinations.validate(ctx.ticketDestination);
			const target = destinationData(ctx.ticketDestination);
			const client = integration.client(target.profile);
			const title = stringArg(args, "title");
			const description = stringArg(args, "description");
			const requestedLabels = ticketLabelNames(args.labels);
			const names = [...new Set([...target.defaultLabels, ...requestedLabels])];
			if (names.some((name) => name.includes(",")))
				throw new Error("GitLab label names cannot contain commas");
			const labels = await client.listLabels(target.projectId, ctx.signal);
			const unknown = requestedLabels.filter(
				(name) =>
					!target.defaultLabels.includes(name) && !labels.some((label) => label.name === name),
			);
			if (unknown.length) throw new Error(`Unknown GitLab labels: ${unknown.join(", ")}`);
			for (const name of target.defaultLabels) {
				await ctx.externalWrites.ensure(
					{ writeType: "gitlab.ensure_label", dedupKey: `${ctx.idempotencyKey}:label:${name}` },
					{
						reconcile: async () =>
							(await client.listLabels(target.projectId, ctx.signal)).find(
								(label) => label.name === name,
							) ?? null,
						execute: () => client.createLabel(target.projectId, name, ctx.signal),
						toMetadata: (label) => ({ name: label.name }),
					},
				);
			}
			const marker = `<!-- leitwerk-ticket-write:${ctx.idempotencyKey} -->`;
			const issue = await ctx.externalWrites.ensure(
				{ writeType: "gitlab.create_issue", dedupKey: ctx.idempotencyKey },
				{
					reconcile: async () =>
						(await client.listIssues(target.projectId, ctx.signal, "all")).find((issue) =>
							issue.description?.includes(marker),
						) ?? null,
					execute: () =>
						client.createIssue(
							target.projectId,
							{ title, description: `${description}\n\n${marker}`, labels: names.join(",") },
							ctx.signal,
						),
					toMetadata: (issue) => ({
						projectId: issue.project_id,
						iid: issue.iid,
						url: issue.web_url,
					}),
				},
			);
			return { externalId: `${target.path}#${issue.iid}`, url: issue.web_url, result: issue };
		},
	});
}
