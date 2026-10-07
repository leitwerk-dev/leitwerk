import type {
	IntegrationToolDefinition,
	IntegrationToolExecutionContext,
} from "@leitwerk-dev/process-sdk";
import { expect, it } from "vitest";
import { createWikiIntegration } from "../integration.js";
import { createWikiFixture } from "./test-fixture.js";
import { registerWikiTools } from "./tools.js";

function fixture() {
	const { store, topic, content: wikiContent } = createWikiFixture();
	const { links: _links, ...pageContent } = wikiContent;
	const wiki = createWikiIntegration(store);
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
		...pageContent,
	};
	const call = (name: string, args: Record<string, unknown>, context = ctx()) =>
		tools.get(name)?.execute(context, args);
	return { wiki, topic, other, ctx, content, call, tools };
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
	for (let replay = 0; replay < 2; replay++)
		expect(await f.call("wiki_edit", edit, f.ctx("editor"))).toMatchObject({
			revision: 2,
			title: f.content.title,
			markdown: edit.markdown,
			evidence: f.content.evidence,
			instanceId: "editor",
			turnRecordId: "turn-editor",
		});
	expect(f.wiki.history(f.topic.id, f.content.pageId)).toHaveLength(2);
	await expect(f.call("wiki_edit", { ...edit, title: "Stale overwrite" })).rejects.toThrow(
		"revision conflict",
	);
	const page = { pageId: f.content.pageId, expectedRevision: 1 };
	await expect(f.call("wiki_delete", page)).rejects.toThrow("revision conflict");
	expect(await f.call("wiki_delete", { ...page, expectedRevision: 2 })).toEqual({
		deleted: true,
		pageId: page.pageId,
	});
	expect(await f.call("wiki_read", page)).toMatchObject({ page: null });
	await expect(f.call("wiki_share", f.content)).rejects.toThrow("deleted page");
	await expect(f.call("wiki_edit", { ...edit, expectedRevision: 3 })).rejects.toThrow(
		"unavailable or deleted",
	);
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
	await expect(f.call("wiki_share", { ...f.content, pageId: "replacement" })).rejects.toThrow(
		"deleted",
	);
	expect(f.wiki.ensureTopic({ ...f.topic, sourceRevision: "new" }).deleted).toBe(true);
	expect(f.wiki.listTopics()).toEqual([f.other]);
	expect(f.wiki.listPages(f.topic.id)).toEqual([]);
	expect(f.tools.get("wiki_delete_group")?.parameters).toMatchObject({
		required: ["expectedRevision"],
		additionalProperties: false,
	});
});
