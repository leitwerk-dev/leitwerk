import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import Fastify from "fastify";
import { expect, it, onTestFinished } from "vitest";
import { registerTopicWikiRoutes } from "./index.js";
import { createWikiFixture } from "./test-fixture.js";

function fixture() {
	const { store, topic, content } = createWikiFixture();
	const page = store.savePage(
		{
			id: "solution",
			topicId: topic.id,
			...content,
			sourceRevision: topic.sourceRevision,
			instanceId: "contributor",
			turnRecordId: "source-turn",
		},
		0,
	);
	const app = Fastify();
	onTestFinished(() => app.close());
	registerTopicWikiRoutes(app, store, () => ADMIN_ACTOR);
	return { app, store, topic, page, url: `/api/wiki/topics/${topic.id}/pages/${page.id}` };
}

it("edits a revision without accepting client-supplied provenance and prevents stale writes and deletes", async () => {
	const f = fixture();
	const payload = {
		...f.page,
		expectedRevision: 1,
		markdown: "Corrected guidance",
		instanceId: "forged",
		turnRecordId: "forged",
		sourceRevision: "forged",
		updatedBy: { id: "forged" },
	};
	const saved = await f.app.inject({ method: "PUT", url: f.url, payload });
	expect(saved.statusCode).toBe(200);
	expect(saved.json().page).toMatchObject({
		revision: 2,
		markdown: "Corrected guidance",
		instanceId: "contributor",
		turnRecordId: "source-turn",
		sourceRevision: "original",
		updatedBy: ADMIN_ACTOR,
	});
	expect(f.store.history(f.topic.id, f.page.id).map((page) => page.markdown)).toEqual([
		"Corrected guidance",
		"Original guidance",
	]);
	expect((await f.app.inject({ method: "PUT", url: f.url, payload })).statusCode).toBe(409);
	expect((await f.app.inject({ method: "DELETE", url: `${f.url}?revision=1` })).statusCode).toBe(
		409,
	);
	expect((await f.app.inject({ method: "DELETE", url: `${f.url}?revision=2` })).statusCode).toBe(
		200,
	);
	expect(
		(
			await f.app.inject({
				method: "PUT",
				url: f.url,
				payload: { ...payload, expectedRevision: 3 },
			})
		).statusCode,
	).toBe(404);
	expect((await f.app.inject(`${f.url}/history`)).statusCode).toBe(404);
});

it.each([
	{ expectedRevision: 0 },
	{ expectedRevision: "1" },
	{ title: " " },
	{ evidence: [] },
	{
		evidence: [
			{
				repository: "team/service",
				revision: "a".repeat(41),
				path: "README.md",
				observation: "Invalid commit",
			},
		],
	},
	{ status: "trusted" },
	{ links: ["https://other.test/page"] },
])("rejects malformed entry edits without changing history: %j", async (patch) => {
	const f = fixture();
	const response = await f.app.inject({
		method: "PUT",
		url: f.url,
		payload: { ...f.page, expectedRevision: 1, ...patch },
	});
	expect(response.statusCode).toBe(400);
	expect(f.store.history(f.topic.id, f.page.id)).toEqual([f.page]);
});

it("invalidates linked guidance and refuses links outside the group", async () => {
	const f = fixture();
	const linked = f.store.savePage({ ...f.page, id: "dependent", links: [f.page.id] }, 0);
	const response = await f.app.inject({
		method: "PUT",
		url: f.url,
		payload: { ...f.page, expectedRevision: 1, markdown: "Corrected" },
	});
	expect(response.statusCode).toBe(200);
	expect(f.store.readPage(f.topic.id, linked.id)?.status).toBe("needs_revalidation");
	const invalid = await f.app.inject({
		method: "PUT",
		url: f.url,
		payload: { ...f.page, expectedRevision: 2, links: ["missing"] },
	});
	expect(invalid.statusCode).toBe(409);
	expect(f.store.readPage(f.topic.id, f.page.id)?.revision).toBe(2);
});

it("deletes a whole group with a fresh revision and hides its entries and history", async () => {
	const f = fixture();
	const groupUrl = `/api/wiki/topics/${f.topic.id}`;
	const snapshot = (await f.app.inject(groupUrl)).json();
	f.store.savePage({ ...f.page, id: "another" }, 0);
	expect(
		(
			await f.app.inject({
				method: "DELETE",
				url: `${groupUrl}?revision=${snapshot.topic.revision}`,
			})
		).statusCode,
	).toBe(409);
	expect(f.store.listPages(f.topic.id)).toHaveLength(2);
	const current = (await f.app.inject(groupUrl)).json();
	expect(
		(
			await f.app.inject({
				method: "DELETE",
				url: `${groupUrl}?revision=${current.topic.revision}`,
			})
		).statusCode,
	).toBe(200);
	expect((await f.app.inject("/api/wiki/topics")).json().topics).toEqual([]);
	expect((await f.app.inject(groupUrl)).statusCode).toBe(404);
	expect((await f.app.inject(`${f.url}/history`)).statusCode).toBe(404);
	expect(f.store.getTopic(f.topic.id)).toMatchObject({
		deleted: true,
		deletion: { actor: ADMIN_ACTOR.id },
	});
});
