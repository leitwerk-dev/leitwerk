import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WikiPage } from "@leitwerk-dev/wiki";
import { createTopicWikiRepo } from "@leitwerk-dev/wiki/server";
import { expect, it } from "vitest";
import {
	createOwnedDatabaseScope,
	createOwnedInMemoryDatabase,
} from "../test-helpers/owned-test-deps.js";
import { closeDatabase, initializeSchema } from "./database.js";
import { createPublicationRepo } from "./publication-repo.js";
import { createAllRepos } from "./repositories.js";

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
	const database = createOwnedInMemoryDatabase();
	const store = createTopicWikiRepo(database);
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

it("keeps wiki revisions and publication receipts inside the host transaction", () => {
	const repos = createAllRepos(createOwnedInMemoryDatabase());
	const topic = repos.topicWiki.ensureTopic(topicInput);
	expect(() =>
		repos.transaction((tx) => {
			tx.topicWiki.savePage(entry(topic.id), 0);
			tx.publications.reservePublication({
				key: "transaction",
				topicId: topic.id,
				binding: {},
				externalId: null,
				url: null,
			});
			throw new Error("Abort outer transaction");
		}),
	).toThrow("Abort outer transaction");
	expect(repos.topicWiki.readPage(topic.id, "solution")).toBeNull();
	expect(repos.topicWiki.history(topic.id, "solution")).toEqual([]);
	expect(repos.topicWiki.getTopic(topic.id)?.revision).toBe(topic.revision);
	expect(repos.publications.publication("transaction")).toBeNull();
	repos.transaction((tx) => tx.topicWiki.savePage(entry(topic.id), 0));
	expect(repos.topicWiki.readPage(topic.id, "solution")?.revision).toBe(1);
});

it("tombstones deleted entries and invalidates dependent guidance without allowing resurrection", () => {
	const database = createOwnedInMemoryDatabase();
	const store = createTopicWikiRepo(database);
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

it("retains whole-group deletion and publication bindings across a file-backed restart", () => {
	const owner = createOwnedDatabaseScope();
	const directory = mkdtempSync(join(tmpdir(), "leitwerk-wiki-group-"));
	const file = join(directory, "state.sqlite");
	try {
		let database = owner.createDatabase({ sqlitePath: file });
		let store = createTopicWikiRepo(database);
		const topic = store.ensureTopic(topicInput);
		const other = store.ensureTopic({ ...topicInput, key: "other-group" });
		store.savePage(entry(topic.id), 0);
		store.savePage(entry(other.id), 0);
		const beforeEdit = store.getTopic(topic.id)!;
		store.savePage({ ...entry(topic.id), markdown: "New finding" }, 1);
		expect(() => store.deleteTopic(topic.id, beforeEdit.revision!, "operator")).toThrow(
			"revision conflict",
		);
		store.savePage({ ...entry(topic.id, "dependent"), links: ["solution"] }, 0);
		createPublicationRepo(database).reservePublication({
			key: "receipt",
			topicId: topic.id,
			binding: { repository: "team/service" },
			externalId: null,
			url: null,
		});
		createPublicationRepo(database).finishPublication(
			"receipt",
			"issue:42",
			"https://tracker.test/42",
		);
		store.deleteTopic(topic.id, store.getTopic(topic.id)!.revision!, "operator");
		closeDatabase(database);
		database = owner.createDatabase({ sqlitePath: file });
		store = createTopicWikiRepo(database);
		expect(store.listTopics().map((group) => group.id)).toEqual([other.id]);
		expect(store.listPages(topic.id)).toEqual([]);
		expect(store.history(topic.id, "solution")).toEqual([]);
		expect(createPublicationRepo(database).publicationByExternalId("issue:42")?.topicId).toBe(
			topic.id,
		);
		expect(store.ensureTopic({ ...topicInput, sourceRevision: "new" })).toMatchObject({
			deleted: true,
		});
		expect(() => store.savePage(entry(topic.id, "new-entry"), 0)).toThrow(
			"group unavailable or deleted",
		);
		expect(store.readPage(other.id, "solution")?.markdown).toContain("migration");
		expect(
			database.$client.prepare("SELECT count(*) AS count FROM wiki_revisions").get()?.count,
		).toBe(6);
	} finally {
		owner.closeOwnedSqlite();
		rmSync(directory, { recursive: true, force: true });
	}
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
			createPublicationRepo(database).reservePublication({
				key: "repo-one",
				topicId: topic.id,
				binding: { repository: "one" },
				externalId: null,
				url: null,
			}),
		).toBe(true);
		expect(
			createPublicationRepo(database).reservePublication({
				key: "repo-one",
				topicId: topic.id,
				binding: { repository: "two" },
				externalId: null,
				url: null,
			}),
		).toBe(false);
		createPublicationRepo(database).finishPublication(
			"repo-one",
			"issue:42",
			"https://tracker.test/42",
		);
		closeDatabase(database);
		database = owner.createDatabase({ sqlitePath: file });
		const restarted = createAllRepos(database);
		expect(restarted.processes.getById(process.id)?.stateJson).toBe('{"tree":"retained"}');
		expect(restarted.topicWiki.readPage(topic.id, "solution")?.markdown).toContain("migration");
		expect(restarted.publications.publicationByExternalId("issue:42")?.binding).toEqual({
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
