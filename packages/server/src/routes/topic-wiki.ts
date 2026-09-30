import type { TopicWikiStore } from "@leitwerk-dev/process-sdk";
import type { FastifyInstance } from "fastify";
import { actorForRequest } from "../auth/fastify-auth.js";

/** @internal */
export function registerTopicWikiRoutes(app: FastifyInstance, store: TopicWikiStore): void {
	app.get("/api/wiki/topics", async () => ({ topics: store.listTopics() }));
	app.get<{ Params: { topicId: string } }>("/api/wiki/topics/:topicId", async (request, reply) => {
		const topic = store.getTopic(request.params.topicId);
		if (!topic) return reply.code(404).send({ error: "Wiki topic unavailable" });
		return { topic, pages: store.listPages(topic.id) };
	});
	app.get<{ Params: { topicId: string; pageId: string } }>(
		"/api/wiki/topics/:topicId/pages/:pageId/history",
		async (request, reply) => {
			if (!store.readPage(request.params.topicId, request.params.pageId))
				return reply.code(404).send({ error: "Wiki entry unavailable or deleted" });
			return { revisions: store.history(request.params.topicId, request.params.pageId) };
		},
	);
	app.delete<{ Params: { topicId: string; pageId: string }; Querystring: { revision?: string } }>(
		"/api/wiki/topics/:topicId/pages/:pageId",
		async (request, reply) => {
			const revision = Number(request.query.revision);
			if (!Number.isSafeInteger(revision) || revision < 1)
				return reply.code(400).send({ error: "A current page revision is required" });
			try {
				store.deletePage(
					request.params.topicId,
					request.params.pageId,
					revision,
					actorForRequest(request).id,
				);
				return { deleted: true };
			} catch (error) {
				return reply
					.code(409)
					.send({ error: error instanceof Error ? error.message : "Wiki deletion conflict" });
			}
		},
	);
}
