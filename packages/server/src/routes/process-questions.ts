import type {
	QuestionRequestMutationResponseBody,
	SubmitQuestionAnswersRequestBody,
} from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance } from "fastify";
import { type RouteDeps, resolveActor } from "./process-route-helpers.js";

export function registerProcessQuestionRoutes(app: FastifyInstance, deps: RouteDeps): void {
	app.post<{
		Params: { instanceId: string; requestId: string };
		Body: SubmitQuestionAnswersRequestBody;
	}>("/api/processes/:instanceId/question-requests/:requestId/answers", async (req, reply) => {
		const result = await deps.processQuestions.submitAnswers(
			req.params.instanceId,
			req.params.requestId,
			req.body?.draft,
			resolveActor(req),
		);
		if (!result.ok) {
			const status = result.code === "not_found" ? 404 : result.code === "not_current" ? 409 : 400;
			return reply.code(status).send(result);
		}
		return { request: result.request } satisfies QuestionRequestMutationResponseBody;
	});
}
