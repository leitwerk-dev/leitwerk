import { createHash } from "node:crypto";
import {
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
import type { JiraCreateProject } from "./client.js";
import type { JiraIntegration } from "./index.js";

function destinationData(snapshot: TicketCreationDestinationSnapshot) {
	const data = objectArg(snapshot.data);
	return {
		profile: stringArg(data, "profile"),
		baseUrl: stringArg(data, "baseUrl"),
		projectId: stringArg(data, "projectId"),
		projectKey: stringArg(data, "projectKey"),
		issueTypeId: stringArg(data, "issueTypeId"),
		defaultLabels: ticketLabelNames(data.defaultLabels),
	};
}

function validateLabels(issueType: JiraCreateProject["issuetypes"][number], labels: string[]) {
	if (labels.length && !Object.hasOwn(issueType.fields, "labels"))
		throw new Error(
			"The selected Jira issue type does not support labels on its create screen; omit labels and set ticket_creation.default_labels to []",
		);
}

/** @internal */
export function registerJiraTicketCreation(
	api: ServerExtensionAPI,
	integration: JiraIntegration,
	config: TicketCreationConfig,
): void {
	if (!config.enabled) return;
	const summary = (
		profile: string,
		project: JiraCreateProject,
		issueType: JiraCreateProject["issuetypes"][number],
	) => ({
		id: `${ticketDestinationId(profile, project.id)}.${issueType.id}`,
		displayName: `${project.key} · ${project.name} / ${issueType.name}`,
		group: `${profile} · ${new URL(integration.client(profile).baseUrl).host}`,
		description: `Issue type: ${issueType.name}. Default labels: ${config.defaultLabels.join(", ") || "none"}. Additional fields: ${JSON.stringify(Object.fromEntries(Object.entries(issueType.fields).filter(([key]) => !["project", "issuetype", "summary", "description", "labels"].includes(key))))}`,
	});
	const currentDestination = async (
		data: ReturnType<typeof destinationData>,
		signal?: AbortSignal,
	) => {
		const client = integration.client(data.profile);
		if (client.baseUrl !== data.baseUrl) throw new Error("Jira profile installation changed");
		const project = (await client.listCreateProjects(data.projectId, signal)).find(
			(project) => project.id === data.projectId,
		);
		const issueType = project?.issuetypes.find(
			(type) => type.id === data.issueTypeId && !type.subtask,
		);
		if (!project || project.key !== data.projectKey || !issueType)
			throw new Error(
				"The selected Jira project or issue type is no longer available for creation",
			);
		validateLabels(issueType, data.defaultLabels);
		return { client, project, issueType };
	};
	const destinations: TicketCreationDestinationProvider = {
		async list() {
			const results = await Promise.all(
				integration.profiles().map(async (profile) => {
					try {
						const projects = await integration.client(profile).listCreateProjects();
						return {
							destinations: projects.flatMap((project) =>
								project.issuetypes
									.filter((type) => !type.subtask)
									.map((type) => summary(profile, project, type)),
							),
							warnings: [],
						};
					} catch {
						return {
							destinations: [],
							warnings: [`Jira profile '${profile}' is currently unavailable.`],
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
			const separator = destinationId.lastIndexOf(".");
			const { profile, resourceId: projectId } = parseTicketDestinationId(
				destinationId.slice(0, separator),
			);
			const issueTypeId = destinationId.slice(separator + 1);
			if (!/^[1-9]\d*$/.test(issueTypeId)) throw new Error("Unknown Jira issue type");
			const client = integration.client(profile);
			const project = (await client.listCreateProjects(projectId)).find(
				(project) => project.id === projectId,
			);
			const issueType = project?.issuetypes.find(
				(type) => type.id === issueTypeId && !type.subtask,
			);
			if (!project || !issueType)
				throw new Error("The selected Jira destination cannot accept issues");
			validateLabels(issueType, config.defaultLabels);
			const destination = summary(profile, project, issueType);
			return {
				summary: {
					...destination,
					description: `Default labels: ${config.defaultLabels.join(", ") || "none"}`,
				},
				data: {
					profile,
					baseUrl: client.baseUrl,
					projectId,
					projectKey: project.key,
					issueTypeId,
					defaultLabels: config.defaultLabels,
				},
				agentContext: destination.description,
			};
		},
		async validate(snapshot) {
			await currentDestination(destinationData(snapshot));
		},
	};
	api.tool<Record<string, unknown>>({
		name: "jira_create_issue",
		description:
			"Create one Jira issue with the selected project's issue type. Supply any required additional fields from its destination metadata; ask the operator when a value is unknown.",
		parameters: {
			type: "object",
			properties: {
				summary: { type: "string", description: "Concise issue title" },
				description: {
					type: "string",
					description: "Complete issue description in Jira wiki markup",
				},
				labels: { type: "array", items: { type: "string" } },
				fields: {
					type: "object",
					description:
						"Additional Jira create fields, keyed by metadata field ID, such as components or customfield_10001. Do not include project, issuetype, summary, description or labels.",
				},
			},
			required: ["summary", "description"],
		},
		capability: {
			kind: "ticket_creation",
			displayName: "Jira",
			processId: "ticket_creation_process",
			startTurnId: "create_ticket",
			titlePath: "/summary",
			descriptionPath: "/description",
			destinations,
		},
		async execute(ctx, args) {
			if (!ctx.ticketDestination) throw new Error("A Jira ticket destination is required");
			ctx.signal.throwIfAborted();
			const target = destinationData(ctx.ticketDestination);
			const { client, issueType } = await currentDestination(target, ctx.signal);
			ctx.signal.throwIfAborted();
			const summary = stringArg(args, "summary");
			const description = stringArg(args, "description");
			const labels = [...new Set([...target.defaultLabels, ...ticketLabelNames(args.labels)])];
			validateLabels(issueType, labels);
			if (labels.some((label) => /\s/.test(label)))
				throw new Error("Jira labels cannot contain spaces");
			const fields = args.fields === undefined ? {} : objectArg(args.fields);
			for (const key of Object.keys(fields)) {
				if (
					["project", "issuetype", "summary", "description", "labels"].includes(key) ||
					!Object.hasOwn(issueType.fields, key)
				)
					throw new Error(
						`Jira field '${key}' is not an additional create field for this issue type`,
					);
			}
			for (const [key, field] of Object.entries(issueType.fields)) {
				if (
					field.required &&
					!field.hasDefaultValue &&
					!["project", "issuetype", "summary", "description", "labels"].includes(key) &&
					(fields[key] == null ||
						fields[key] === "" ||
						(Array.isArray(fields[key]) && fields[key].length === 0))
				)
					throw new Error(
						`Jira requires ${field.name} (${key}); request this value before creating the issue`,
					);
			}
			const digest = createHash("sha256").update(ctx.idempotencyKey).digest("hex");
			const marker = `leitwerk-ticket-write:${digest}`;
			const issue = await ctx.externalWrites.ensure(
				{ writeType: "jira.create_issue", dedupKey: ctx.idempotencyKey },
				{
					reconcile: async () =>
						(await client.listProjectIssues(target.projectId, ctx.signal)).find((issue) =>
							issue.fields.description?.includes(marker),
						) ?? null,
					execute: () => {
						ctx.signal.throwIfAborted();
						return client.createIssue(
							{
								...fields,
								project: { id: target.projectId },
								issuetype: { id: target.issueTypeId },
								summary,
								description: `${description}\n\n{noformat}${marker}{noformat}`,
								...(labels.length ? { labels } : {}),
							},
							ctx.signal,
						);
					},
					toMetadata: (issue) => ({
						id: issue.id,
						key: issue.key,
						url: `${target.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
					}),
				},
			);
			return {
				externalId: issue.key,
				url: `${target.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
				result: issue,
			};
		},
	});
}
