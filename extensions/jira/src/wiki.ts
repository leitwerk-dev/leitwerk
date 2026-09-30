import { createHash } from "node:crypto";
import { asUnknownRecord, type WikiEvidence, type WikiPage } from "@leitwerk-dev/domain";
import {
	type ServerExtensionAPI,
	stringArg,
	type TopicWikiStore,
	topicWikiCapability,
} from "@leitwerk-dev/process-sdk";
import { type JiraClientLike, type JiraIssue, jiraIsEpic } from "./client.js";
import type { JiraIntegration } from "./index.js";

/** @internal */
export function jiraEpicRevision(epic: JiraIssue): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				epic.id,
				epic.fields.project.id,
				epic.fields.summary,
				epic.fields.description,
				epic.fields.components,
				epic.fields.status,
			]),
		)
		.digest("hex");
}

/** @internal */
export function ensureEpicWiki(store: TopicWikiStore, client: JiraClientLike, epic: JiraIssue) {
	return ensureIssueWiki(store, client, epic);
}

/** @internal */
export function ensureIssueWiki(store: TopicWikiStore, client: JiraClientLike, issue: JiraIssue) {
	return store.ensureTopic({
		key: JSON.stringify([jiraIsEpic(issue) ? "jira.epic" : "jira.issue", client.baseUrl, issue.id]),
		title: `${issue.key}: ${issue.fields.summary}`,
		url: `${client.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
		sourceRevision: jiraEpicRevision(issue),
	});
}

/** @internal */
export function registerJiraWikiTools(api: ServerExtensionAPI, integration: JiraIntegration): void {
	const store = api.get(topicWikiCapability);
	if (!store || Array.isArray(store)) return;
	for (const name of ["wiki_index", "wiki_read", "wiki_share"] as const)
		api.tool<Record<string, unknown>>({
			name,
			description:
				"Read or contribute evidence-backed solutions in this process's source issue wiki. Refresh before revising; deleted entries cannot be restored.",
			parameters: {
				type: "object",
				properties: {
					pageId: { type: "string" },
					query: { type: "string" },
					expectedRevision: { type: "integer" },
					title: { type: "string" },
					markdown: { type: "string" },
					applicability: { type: "string" },
					status: {
						type: "string",
						enum: ["proposed", "observed", "validated", "needs_revalidation"],
					},
					evidence: {
						type: "array",
						items: {
							type: "object",
							properties: {
								repository: { type: "string" },
								revision: { type: "string" },
								path: { type: "string" },
								observation: { type: "string" },
							},
							required: ["repository", "revision", "path", "observation"],
						},
					},
					links: { type: "array", items: { type: "string" } },
				},
				additionalProperties: false,
			},
			async execute(ctx, args) {
				const binding = asUnknownRecord(ctx.process.metadata?.wiki);
				const issueId = binding?.issueId ?? binding?.epicId;
				if (
					!binding ||
					typeof binding.topicId !== "string" ||
					typeof binding.profile !== "string" ||
					typeof issueId !== "string"
				)
					throw new Error("This process has no source issue wiki binding");
				const client = integration.client(binding.profile);
				if (client.baseUrl !== binding.baseUrl) throw new Error("Jira wiki installation changed");
				const topic = ensureIssueWiki(store, client, await client.getIssue(issueId));
				if (topic.id !== binding.topicId) throw new Error("Source issue wiki binding mismatch");
				if (name === "wiki_index") {
					const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
					return {
						topic,
						pages: store
							.listPages(topic.id)
							.filter(
								(page) =>
									!query ||
									`${page.title} ${page.applicability} ${page.markdown}`
										.toLowerCase()
										.includes(query),
							)
							.map(({ id, revision, title, applicability, status, updatedAt }) => ({
								id,
								revision,
								title,
								applicability,
								status,
								updatedAt,
							})),
					};
				}
				const pageId = stringArg(args, "pageId");
				if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(pageId))
					throw new Error("Use a stable alphanumeric wiki page ID");
				if (name === "wiki_read")
					return {
						page: store.readPage(topic.id, pageId),
						instruction:
							"Evidence describes its recorded revision. Verify the current repository before reuse; null means unavailable or deleted.",
					};
				if (!Number.isSafeInteger(args.expectedRevision) || Number(args.expectedRevision) < 0)
					throw new Error("Read the current page revision before editing");
				if (
					!["proposed", "observed", "validated", "needs_revalidation"].includes(String(args.status))
				)
					throw new Error("Invalid wiki evidence status");
				if (!Array.isArray(args.evidence) || args.evidence.length === 0)
					throw new Error("Wiki contributions require evidence");
				const evidence: WikiEvidence[] = args.evidence.map((value) => {
					const record = asUnknownRecord(value);
					if (!record) throw new Error("Invalid wiki evidence");
					if (typeof record.revision !== "string" || !/^[a-f0-9]{40,64}$/i.test(record.revision))
						throw new Error("Wiki evidence requires the inspected repository commit SHA");
					return {
						repository: stringArg(record, "repository"),
						revision: stringArg(record, "revision"),
						path: stringArg(record, "path"),
						observation: stringArg(record, "observation"),
					};
				});
				if (
					args.links !== undefined &&
					(!Array.isArray(args.links) || args.links.some((link) => typeof link !== "string"))
				)
					throw new Error("Wiki links must be page IDs");
				const current = store.readPage(topic.id, pageId);
				if (
					current?.turnRecordId === ctx.turn.id &&
					current.revision === Number(args.expectedRevision) + 1 &&
					current.markdown === args.markdown &&
					current.title === args.title &&
					current.applicability === args.applicability &&
					current.status === args.status &&
					JSON.stringify(current.evidence) === JSON.stringify(evidence) &&
					JSON.stringify(current.links) === JSON.stringify(args.links ?? [])
				)
					return current;
				return store.savePage(
					{
						id: pageId,
						topicId: topic.id,
						title: stringArg(args, "title"),
						markdown: stringArg(args, "markdown"),
						applicability: stringArg(args, "applicability"),
						status: args.status as WikiPage["status"],
						evidence,
						links: (args.links ?? []) as string[],
						sourceRevision: topic.sourceRevision,
						instanceId: ctx.process.id,
						turnRecordId: ctx.turn.id,
					},
					Number(args.expectedRevision),
				);
			},
		});
}
