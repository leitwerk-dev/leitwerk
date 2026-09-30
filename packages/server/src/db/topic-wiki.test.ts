import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WikiPage } from "@leitwerk-dev/domain";
import { expect, it } from "vitest";
import {
	createOwnedDatabaseScope,
	createOwnedInMemoryDatabase,
} from "../test-helpers/owned-test-deps.js";
import { closeDatabase, initializeSchema } from "./database.js";
import { createAllRepos } from "./repositories.js";
import { createTopicWikiRepo } from "./topic-wiki-repo.js";

const topicInput = {
	key: "epic:one",
	title: "Standardize",
	url: "https://tracker.test/EPIC-1",
	sourceRevision: "original",
};
function entry(
	topicId: string,
	id = "solution",
): Omit<WikiPage, "revision" | "updatedAt" | "deleted"> {
	return {
		id,
		topicId,
		title: "Use the supported migration",
		markdown: "Apply the migration, then run checks.",
		applicability: "Repositories using version 1",
		evidence: [
			{
				repository: "team/repo",
				revision: "a".repeat(40),
				path: "package.json",
				observation: "Migration test passed",
			},
		],
		links: [],
		sourceRevision: "original",
		instanceId: "author",
		turnRecordId: "turn",
		status: "observed",
	};
}

it("isolates epic pages, rejects lost updates, and flags changed source evidence", () => {
	const store = createTopicWikiRepo(createOwnedInMemoryDatabase());
	const first = store.ensureTopic(topicInput),
		second = store.ensureTopic({ ...topicInput, key: "epic:two" });
	const page = store.savePage(entry(first.id), 0);
	expect(store.readPage(second.id, page.id)).toBeNull();
	expect(() => store.savePage({ ...entry(first.id), markdown: "stale overwrite" }, 0)).toThrow(
		"revision conflict",
	);
	store.savePage({ ...entry(first.id), markdown: "Corrected finding" }, 1);
	expect(store.history(first.id, page.id)).toHaveLength(2);
	store.ensureTopic({ ...topicInput, sourceRevision: "updated" });
	expect(store.readPage(first.id, page.id)?.status).toBe("needs_revalidation");
});

it("tombstones deleted entries and invalidates dependent guidance without allowing resurrection", () => {
	const store = createTopicWikiRepo(createOwnedInMemoryDatabase());
	const topic = store.ensureTopic(topicInput);
	store.savePage(entry(topic.id), 0);
	store.savePage({ ...entry(topic.id, "derived"), links: ["solution"] }, 0);
	store.savePage({ ...entry(topic.id, "transitive"), links: ["derived"] }, 0);
	store.deletePage(topic.id, "solution", 1, "operator");
	expect(store.readPage(topic.id, "solution")).toBeNull();
	expect(store.history(topic.id, "solution")).toEqual([]);
	expect(store.readPage(topic.id, "derived")?.status).toBe("needs_revalidation");
	expect(store.readPage(topic.id, "transitive")?.status).toBe("needs_revalidation");
	expect(() => store.savePage(entry(topic.id), 1)).toThrow("deleted page");
	expect(() => store.savePage(entry(topic.id), 0)).toThrow("deleted page");
});

it.each([
	"startup",
	"operator SQL",
])("migrates file-backed wiki storage through %s and retains publications after restart", (mode) => {
	const owner = createOwnedDatabaseScope();
	const directory = mkdtempSync(join(tmpdir(), "leitwerk-wiki-"));
	const file = join(directory, "state.sqlite");
	try {
		let database = owner.createDatabase({ sqlitePath: file });
		const process = createAllRepos(database).processes.create({
			processId: "retained",
			stateJson: '{"tree":"retained"}',
		});
		database.$client.exec(
			"DROP TABLE topic_publications; DROP TABLE wiki_revisions; DROP TABLE wiki_pages; DROP TABLE wiki_topics;",
		);
		if (mode === "operator SQL") {
			database.$client.exec(
				readFileSync(
					new URL("../../migrations/20260930_add_topic_wiki.sql", import.meta.url),
					"utf8",
				),
			);
			initializeSchema(database.$client);
		}
		closeDatabase(database);
		database = owner.createDatabase({ sqlitePath: file });
		const store = createTopicWikiRepo(database);
		const topic = store.ensureTopic(topicInput);
		store.savePage(entry(topic.id), 0);
		expect(
			store.reservePublication({
				key: "repo-one",
				topicId: topic.id,
				binding: { repository: "one" },
				externalId: null,
				url: null,
			}),
		).toBe(true);
		expect(
			store.reservePublication({
				key: "repo-one",
				topicId: topic.id,
				binding: { repository: "two" },
				externalId: null,
				url: null,
			}),
		).toBe(false);
		store.finishPublication("repo-one", "issue:42", "https://tracker.test/42");
		closeDatabase(database);
		database = owner.createDatabase({ sqlitePath: file });
		const restarted = createAllRepos(database);
		expect(restarted.processes.getById(process.id)?.stateJson).toBe('{"tree":"retained"}');
		expect(restarted.topicWiki.readPage(topic.id, "solution")?.markdown).toContain("migration");
		expect(restarted.topicWiki.publicationByExternalId("issue:42")?.binding).toEqual({
			repository: "one",
		});
		if (mode === "startup")
			expect(readdirSync(join(directory, "backups")).some((name) => name.endsWith(".bak"))).toBe(
				true,
			);
	} finally {
		owner.closeOwnedSqlite();
		rmSync(directory, { recursive: true, force: true });
	}
});
