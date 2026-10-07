import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { onTestFinished } from "vitest";
import type { WikiPageContent } from "../model.js";
import { createTopicWikiRepo } from "./store.js";

/** @internal */
export function createWikiFixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec(`CREATE TABLE wiki_topics (id TEXT PRIMARY KEY, key TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE wiki_pages (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES wiki_topics(id), data TEXT NOT NULL);
 CREATE TABLE wiki_revisions (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES wiki_pages(id), data TEXT NOT NULL);`);
	const store = createTopicWikiRepo(drizzle({ client: sqlite }));
	const topic = store.ensureTopic({
		key: "issue:one",
		title: "Source issue",
		url: "https://tracker.test/1",
		sourceRevision: "original",
	});
	const content: WikiPageContent = {
		title: "A reusable solution",
		markdown: "Original guidance",
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
		links: [],
	};
	return { store, topic, content };
}
