import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { createTestDeps } from "@leitwerk-dev/server/testing";
import { createToolCollector } from "@leitwerk-dev/test-support";
import { createWikiIntegration } from "@leitwerk-dev/wiki/integration";
import { registerWikiTools } from "@leitwerk-dev/wiki/server";
import { expect, it, onTestFinished } from "vitest";
import type { JiraIssue } from "./client.js";
import { LocalJiraSplitAdapter } from "./testing.js";
import { ensureIssueWiki, jiraWikiSource } from "./wiki.js";

function fixture() {
	const deps = createTestDeps();
	onTestFinished(() => deps.db.$client.close());
	const store = deps.topicWiki;
	const client = new LocalJiraSplitAdapter();
	const issue: JiraIssue = {
		id: "501",
		key: "APP-1",
		fields: {
			summary: "Change",
			description: null,
			labels: [],
			components: [],
			project: { id: "100", key: "APP", name: "App" },
			status: { statusCategory: { key: "new" } },
		},
	};
	client.seedIssue(issue);
	const topic = ensureIssueWiki(store, client, issue);
	const collector = createToolCollector();
	const wiki = createWikiIntegration(store);
	wiki.registerProcessSource(
		"test_process",
		jiraWikiSource(store, { profiles: () => ["team"], client: () => client }),
	);
	registerWikiTools(collector.api, wiki);
	const ctx = {
		process: {
			id: "process",
			processId: "test_process",
			metadata: {
				wiki: { topicId: topic.id, profile: "team", baseUrl: client.baseUrl, issueId: issue.id },
			},
		},
		turn: { id: "accepted-turn" },
	} as IntegrationToolExecutionContext;
	return {
		store,
		topic,
		ctx,
		client,
		issue,
		call: (name: string, args: Record<string, unknown>) =>
			collector.tools.get(name)!.execute(ctx, args),
	};
}

it("does not recreate a deleted Jira source wiki during refresh", async () => {
	const f = fixture();
	await f.call("wiki_delete_group", { expectedRevision: f.topic.revision });
	expect(ensureIssueWiki(f.store, f.client, f.issue).deleted).toBe(true);
	expect(f.store.getTopic(f.topic.id)?.deletion?.turnRecordId).toBe("accepted-turn");
	await expect(f.call("wiki_index", {})).rejects.toThrow("group was deleted");
});

it("requires current revisions and a valid source binding for mutations", async () => {
	const f = fixture();
	for (const name of ["wiki_edit", "wiki_delete", "wiki_delete_group"])
		await expect(f.call(name, { pageId: "solution", expectedRevision: 0 })).rejects.toThrow(
			"current",
		);
	f.ctx.process.metadata = {
		wiki: {
			topicId: f.topic.id,
			profile: "team",
			baseUrl: "https://other.test",
			issueId: f.issue.id,
		},
	};
	await expect(f.call("wiki_delete_group", { expectedRevision: 1 })).rejects.toThrow(
		"installation changed",
	);
	expect(f.store.getTopic(f.topic.id)?.deleted).toBe(false);
});
