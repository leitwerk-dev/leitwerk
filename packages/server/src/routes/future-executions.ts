import type { CronPreviewResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance } from "fastify";
import { nextCronOccurrenceUtc } from "../domain-logic/cron.js";
import type { FutureExecutionLifecycle } from "../future-execution/index.js";
import { buildFutureExecutionListView } from "../future-execution-presenter.js";
import {
	normalizeActionRequest,
	normalizeLauncherRequest,
	type RouteDeps,
	resolveActor,
	sendActionRequestNormalizationError,
	sendLauncherMutationResponse,
	sendLauncherRequestNormalizationError,
	sendScheduledActionMutationResponse,
} from "./process-route-helpers.js";

export function registerFutureExecutionRoutes(
	app: FastifyInstance,
	deps: RouteDeps,
	futureExecutionLifecycle: FutureExecutionLifecycle,
) {
	app.post<{ Body: { expression?: unknown } }>(
		"/api/future-executions/cron-preview",
		async (req, reply) => {
			const expression = typeof req.body?.expression === "string" ? req.body.expression.trim() : "";
			if (!expression) {
				return reply.code(400).send({ error: "expression must be a non-empty string" });
			}
			try {
				const body = {
					nextRunAt: nextCronOccurrenceUtc(expression),
				} satisfies CronPreviewResponseBody;
				return body;
			} catch (error) {
				return reply.code(400).send({
					error: error instanceof Error ? error.message : "Invalid cron expression",
				});
			}
		},
	);

	app.get<{ Params: { futureExecutionId: string } }>(
		"/api/future-executions/:futureExecutionId",
		async (req, reply) => {
			const execution = deps.futureExecutions.getById(req.params.futureExecutionId);
			if (!execution) {
				return reply.code(404).send({ error: "Future execution not found" });
			}
			const summary = buildFutureExecutionListView(deps, execution);
			if (!summary) {
				return reply.code(404).send({ error: "Future execution not found" });
			}
			return summary;
		},
	);

	app.delete<{ Params: { futureExecutionId: string } }>(
		"/api/future-executions/:futureExecutionId",
		async (req, reply) => {
			const result = await futureExecutionLifecycle.cancel(req.params.futureExecutionId);
			if (result.kind === "not_found") {
				return reply.code(404).send({ error: "Scheduled item not found" });
			}
			return reply.code(200).send({
				ok: true,
				...(result.kind === "committed_with_reaction_error"
					? { error: result.error, code: result.code }
					: {}),
			});
		},
	);

	app.put<{ Params: { futureExecutionId: string }; Body: unknown }>(
		"/api/future-executions/:futureExecutionId/launch",
		async (req, reply) => {
			const normalized = normalizeLauncherRequest(req.body);
			if (!normalized.ok) {
				return sendLauncherRequestNormalizationError(reply, normalized.error);
			}
			const result = await futureExecutionLifecycle.reviseScheduledLaunch(
				req.params.futureExecutionId,
				normalized.request,
				{ actor: resolveActor(req) },
			);
			return sendLauncherMutationResponse(reply, deps, result);
		},
	);

	app.put<{ Params: { futureExecutionId: string }; Body: unknown }>(
		"/api/future-executions/:futureExecutionId/action",
		async (req, reply) => {
			const normalized = normalizeActionRequest(req.body);
			if (!normalized.ok) {
				return sendActionRequestNormalizationError(reply, normalized.error);
			}
			const result = await futureExecutionLifecycle.reviseScheduledAction(
				req.params.futureExecutionId,
				normalized.request,
				{ actor: resolveActor(req) },
			);
			return sendScheduledActionMutationResponse(reply, deps, result);
		},
	);
}
