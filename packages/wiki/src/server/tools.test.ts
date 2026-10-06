import { DatabaseSync } from "node:sqlite";
import type {
	IntegrationToolDefinition,
	IntegrationToolExecutionContext,
} from "@leitwerk-dev/process-sdk";
import { drizzle } from "drizzle-orm/node-sqlite";
import { expect, it, onTestFinished } from "vitest";
import { createWikiIntegration } from "../integration.js";
import { createTopicWikiRepo } from "./store.js";
import { registerWikiTools } from "./tools.js";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec(`
		CREATE TABLE wiki_topics (id TEXT PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL);
		CREATE TABLE wiki_pages (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES wiki_topics(id), data TEXT NOT NULL);
		CREATE TABLE wiki_revisions (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES wiki_pages(id), data TEXT NOT NULL);
	`);
	const database = drizzle({ client: sqlite });
	const wiki = createWikiIntegration(createTopicWikiRepo(database));
	const topic = wiki.ensureTopic({
		key: "shared-migration",
		title: "Migration",
		url: "https://tracker.test/1",
		sourceRevision: "one",
	});
	const other = wiki.ensureTopic({ ...topic, key: "other-migration" });
	const tools = new Map<string, IntegrationToolDefinition>();
	registerWikiTools(
		{ tool: (definition) => tools.set(definition.name, definition as IntegrationToolDefinition) },
		wiki,
	);
	const ctx = (instanceId = "author", topicId = topic.id) =>
		({
			process: { id: instanceId, processId: "plain_process", metadata: { wiki: { topicId } } },
			turn: { id: `turn-${instanceId}` },
		}) as IntegrationToolExecutionContext;
	const content = {
		pageId: "shared-compatibility",
		expectedRevision: 0,
		title: "Use the compatible version",
		markdown:
			"Use version 3.8 for the inspected integration; older versions fail its compatibility check.",
		applicability: "Other services using the same integration",
		status: "observed",
		evidence: [
			{
				repository: "team/service",
				revision: "a".repeat(40),
				path: "build.gradle.kts",
				observation: "Inspected dependency constraint",
			},
		],
	};
	const call = (name: string, args: Record<string, unknown>, context = ctx()) =>
		tools.get(name)?.execute(context, args);
	return { wiki, topic, other, ctx, content, call };
}

it("shares solutions across processes without a provider and isolates other topics", async () => {
	const f = fixture();
	await f.call("wiki_share", { ...f.content, topicId: f.other.id, instanceId: "forged" });
	const result = await f.call("wiki_read", { pageId: f.content.pageId }, f.ctx("consumer"));
	expect(result).toMatchObject({
		page: { topicId: f.topic.id, instanceId: "author", turnRecordId: "turn-author" },
	});
	expect(
		await f.call(
			"wiki_read",
			{ pageId: f.content.pageId, topicId: f.topic.id },
			f.ctx("outsider", f.other.id),
		),
	).toMatchObject({ page: null });
	expect(f.wiki.listPages(f.other.id)).toEqual([]);
	await expect(
		f.call("wiki_share", { ...f.content, pageId: "derived", links: ["missing"] }),
	).rejects.toThrow("another current page");
});

it("requires binding resolvers for provider metadata and returns refreshed shared requirements", async () => {
	const f = fixture();
	const ctx = f.ctx();
	ctx.process.metadata = { wiki: { topicId: f.topic.id, source: "retained-source" } };
	await expect(f.call("wiki_index", {}, ctx)).rejects.toThrow("source resolver unavailable");
	f.wiki.registerProcessSource("plain_process", async (_ctx, binding) => {
		expect(binding.source).toBe("retained-source");
		return {
			topic: f.wiki.ensureTopic({ ...f.topic, sourceRevision: "updated" }),
			sourceDescription: "The shared ticket already requires version 3.8.",
		};
	});
	expect(await f.call("wiki_index", {}, ctx)).toMatchObject({
		sourceDescription: "The shared ticket already requires version 3.8.",
		topic: { sourceRevision: "updated" },
	});
	expect(() =>
		f.wiki.registerProcessSource("plain_process", async () => ({ topic: f.topic })),
	).toThrow("already registered");
});

it("rejects a resolver that changes topic identity or cannot refresh its source", async () => {
	const f = fixture();
	f.wiki.registerProcessSource("plain_process", async () => ({ topic: f.other }));
	await expect(f.call("wiki_share", f.content)).rejects.toThrow("binding mismatch");
	f.wiki.registerProcessSource("unavailable_source", async () => {
		throw new Error("Source unavailable");
	});
	const ctx = f.ctx();
	ctx.process.processId = "unavailable_source";
	await expect(f.call("wiki_share", f.content, ctx)).rejects.toThrow("Source unavailable");
	expect(f.wiki.listPages(f.topic.id)).toEqual([]);
});

it("reconciles replays, rejects concurrent edits, and prevents deletion from being undone", async () => {
	const f = fixture();
	await f.call("wiki_share", f.content);
	await f.call("wiki_share", f.content);
	expect(f.wiki.history(f.topic.id, f.content.pageId)).toHaveLength(1);
	const edit = {
		pageId: f.content.pageId,
		expectedRevision: 1,
		markdown: "Refined compatibility solution",
	};
	await f.call("wiki_edit", edit, f.ctx("editor"));
	await expect(f.call("wiki_edit", { ...edit, title: "Stale overwrite" })).rejects.toThrow(
		"revision conflict",
	);
	await f.call("wiki_delete_group", { expectedRevision: f.wiki.getTopic(f.topic.id)?.revision });
	await expect(f.call("wiki_share", { ...f.content, pageId: "replacement" })).rejects.toThrow(
		"deleted",
	);
	expect(f.wiki.ensureTopic({ ...f.topic, sourceRevision: "new" }).deleted).toBe(true);
});
