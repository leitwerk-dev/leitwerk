import { createHash } from "node:crypto";
import type { TopicWikiStore } from "@leitwerk-dev/wiki";
import type { WikiSourceResolver } from "@leitwerk-dev/wiki/integration";
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
export function ensureIssueWiki(
	store: TopicWikiStore,
	client: JiraClientLike,
	issue: JiraIssue,
	retainedTopicId?: string,
) {
	let key = JSON.stringify([
		jiraIsEpic(issue) ? "jira.epic" : "jira.issue",
		client.baseUrl,
		issue.id,
	]);
	if (retainedTopicId !== undefined) {
		// Only callers with a durable publication receipt or process binding may supply an ID.
		// Older publishers used their own namespace for the same installation / issue identity.
		const topic = store.getTopic(retainedTopicId);
		let identity: unknown;
		try {
			identity = topic && JSON.parse(topic.key);
		} catch {
			identity = null;
		}
		if (
			!topic ||
			!Array.isArray(identity) ||
			identity.length !== 3 ||
			typeof identity[0] !== "string" ||
			!identity[0] ||
			identity[1] !== client.baseUrl ||
			identity[2] !== issue.id
		)
			throw new Error("Source issue wiki binding mismatch");
		key = topic.key;
	}
	return store.ensureTopic({
		key,
		title: `${issue.key}: ${issue.fields.summary}`,
		url: `${client.baseUrl}/browse/${encodeURIComponent(issue.key)}`,
		sourceRevision: jiraEpicRevision(issue),
	});
}

/** Refreshes retained current and legacy issue bindings; credentials stay in the integration. @internal */
export function jiraWikiSource(
	store: TopicWikiStore,
	integration: JiraIntegration,
): WikiSourceResolver {
	return async (_ctx, binding) => {
		const issueId = binding.issueId ?? binding.epicId;
		if (
			typeof binding.topicId !== "string" ||
			typeof binding.profile !== "string" ||
			typeof issueId !== "string"
		)
			throw new Error("This process has no source issue wiki binding");
		const client = integration.client(binding.profile);
		if (client.baseUrl !== binding.baseUrl) throw new Error("Jira wiki installation changed");
		const issue = await client.getIssue(issueId);
		if (issue.id !== issueId) throw new Error("Source issue wiki binding mismatch");
		return {
			topic: ensureIssueWiki(store, client, issue, binding.topicId),
			sourceDescription: issue.fields.description ?? "",
		};
	};
}
