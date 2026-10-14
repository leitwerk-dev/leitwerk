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
	const content = {
		pageId: "solution",
		expectedRevision: 0,
		title: "Solution",
		markdown: "Original",
		applicability: "Version one",
		status: "observed",
		evidence: [
			{
				repository: "team/service",
				revision: "a".repeat(40),
				path: "README.md",
				observation: "Inspected repository",
			},
		],
	};
	return {
		store,
		topic,
		ctx,
		client,
		issue,
		content,
		tools: collector.tools,
		call: (name: string, args: Record<string, unknown>) =>
			collector.tools.get(name)!.execute(ctx, args),
	};
}

it("edits selected content, preserves evidence, records accepted-turn provenance, and handles retries", async () => {
	const f = fixture();
	await f.call("wiki_share", f.content);
	const edit = { pageId: "solution", expectedRevision: 1, markdown: "Corrected guidance" };
	expect(await f.call("wiki_edit", edit)).toMatchObject({
		revision: 2,
		markdown: "Corrected guidance",
		title: "Solution",
		evidence: f.content.evidence,
		instanceId: f.ctx.process.id,
		turnRecordId: f.ctx.turn.id,
	});
	expect(await f.call("wiki_edit", edit)).toMatchObject({ revision: 2 });
	expect(f.store.history(f.topic.id, "solution")).toHaveLength(2);
	await expect(f.call("wiki_edit", { ...edit, title: "A stale correction" })).rejects.toThrow(
		"revision conflict",
	);
	await expect(f.call("wiki_delete", { pageId: "solution", expectedRevision: 1 })).rejects.toThrow(
		"revision conflict",
	);
	expect(await f.call("wiki_delete", { pageId: "solution", expectedRevision: 2 })).toEqual({
		deleted: true,
		pageId: "solution",
	});
	expect(await f.call("wiki_read", { pageId: "solution" })).toMatchObject({ page: null });
	await expect(f.call("wiki_share", f.content)).rejects.toThrow("deleted page");
	await expect(f.call("wiki_edit", { ...edit, expectedRevision: 3 })).rejects.toThrow(
		"unavailable or deleted",
	);
});

it("deletes a complete group only after reading its current revision, without allowing recreation", async () => {
	const f = fixture();
	await f.call("wiki_share", f.content);
	const snapshot = (await f.call("wiki_index", {})) as { topic: { revision: number } };
	await f.call("wiki_share", { ...f.content, pageId: "another" });
	await expect(
		f.call("wiki_delete_group", { expectedRevision: snapshot.topic.revision }),
	).rejects.toThrow("group revision conflict");
	const current = (await f.call("wiki_index", {})) as { topic: { revision: number } };
	expect(await f.call("wiki_delete_group", { expectedRevision: current.topic.revision })).toEqual({
		deleted: true,
		topicId: f.topic.id,
	});
	expect(f.store.listTopics()).toEqual([]);
	expect(f.store.listPages(f.topic.id)).toEqual([]);
	await expect(f.call("wiki_share", { ...f.content, pageId: "recreated" })).rejects.toThrow(
		"group was deleted",
	);
	expect(ensureIssueWiki(f.store, f.client, f.issue).deleted).toBe(true);
	expect(f.store.getTopic(f.topic.id)?.deletion?.turnRecordId).toBe("accepted-turn");
	expect(f.tools.get("wiki_delete_group")?.parameters).toMatchObject({
		required: ["expectedRevision"],
		additionalProperties: false,
	});
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
