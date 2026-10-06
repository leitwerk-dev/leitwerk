import { type Actor, asUnknownRecord } from "@leitwerk-dev/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { isWikiPageId, parseWikiPageContent } from "../model.js";
import type { TopicWikiStore } from "../store.js";

/** @internal */
export function registerTopicWikiRoutes(
	app: FastifyInstance,
	store: TopicWikiStore,
	actorForRequest: (request: FastifyRequest) => Actor,
): void {
	app.get("/api/wiki/topics", async () => ({ topics: store.listTopics() }));
	app.get<{ Params: { topicId: string } }>("/api/wiki/topics/:topicId", async (request, reply) => {
		const topic = store.getTopic(request.params.topicId);
		if (!topic || topic.deleted)
			return reply.code(404).send({ error: "Wiki group unavailable or deleted" });
		return { topic, pages: store.listPages(topic.id) };
	});
	app.delete<{ Params: { topicId: string }; Querystring: { revision?: string } }>(
		"/api/wiki/topics/:topicId",
		async (request, reply) => {
			const revision = Number(request.query.revision);
			if (!Number.isSafeInteger(revision) || revision < 1)
				return reply.code(400).send({ error: "A current wiki group revision is required" });
			try {
				store.deleteTopic(request.params.topicId, revision, actorForRequest(request).id);
				return { deleted: true };
			} catch (error) {
				return reply
					.code(409)
					.send({ error: error instanceof Error ? error.message : "Wiki group deletion conflict" });
			}
		},
	);
	app.get<{ Params: { topicId: string; pageId: string } }>(
		"/api/wiki/topics/:topicId/pages/:pageId/history",
		async (request, reply) => {
			if (!store.readPage(request.params.topicId, request.params.pageId))
				return reply.code(404).send({ error: "Wiki entry unavailable or deleted" });
			return { revisions: store.history(request.params.topicId, request.params.pageId) };
		},
	);
	app.put<{ Params: { topicId: string; pageId: string }; Body: unknown }>(
		"/api/wiki/topics/:topicId/pages/:pageId",
		async (request, reply) => {
			const input = asUnknownRecord(request.body);
			if (
				!input ||
				!Number.isSafeInteger(input.expectedRevision) ||
				Number(input.expectedRevision) < 1
			)
				return reply.code(400).send({ error: "A current page revision is required" });
			if (!isWikiPageId(request.params.pageId))
				return reply.code(400).send({ error: "Use a stable alphanumeric wiki page ID" });
			const current = store.readPage(request.params.topicId, request.params.pageId);
			if (!current) return reply.code(404).send({ error: "Wiki entry unavailable or deleted" });
			let content: ReturnType<typeof parseWikiPageContent>;
			try {
				content = parseWikiPageContent(input);
			} catch (error) {
				return reply
					.code(400)
					.send({ error: error instanceof Error ? error.message : "Invalid wiki entry" });
			}
			try {
				return {
					page: store.savePage(
						{ ...current, ...content, updatedBy: actorForRequest(request) },
						Number(input.expectedRevision),
					),
				};
			} catch (error) {
				return reply.code(409).send({
					error:
						error instanceof Error
							? error.message
							: "Wiki revision conflict; refresh before editing",
				});
			}
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
