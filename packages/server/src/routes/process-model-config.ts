import type { ProcessModelConfigResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import type { FastifyInstance } from "fastify";
import { reconcileFutureExecutionModelBlocks } from "../future-execution/reconciliation.js";
import { UpdateModelConfig } from "../process-engine/ops/update-model-config.js";
import {
	parseProcessModelConfigPatch,
	prepareProcessModelConfig,
} from "../process-model-config.js";
import { getProcessOrReply, type RouteDeps, resolveActor } from "./process-route-helpers.js";

export function registerProcessModelConfigRoutes(app: FastifyInstance, deps: RouteDeps) {
	for (const preview of [true, false]) {
		app.route<{ Params: { instanceId: string } }>({
			method: preview ? "POST" : "PATCH",
			url: `/api/processes/:instanceId/model-config${preview ? "/preview" : ""}`,
			async handler(req, reply): Promise<ProcessModelConfigResponseBody | undefined> {
				const process = getProcessOrReply(deps, req.params.instanceId, reply);
				if (!process) return;
				const policy = deps.processModelPolicy;
				const cache = deps.modelStatusCache;
				if (!policy || !cache || !deps.processActionRegistry)
					return reply.code(503).send({ error: "Model policy is unavailable" });
				let patch: ReturnType<typeof parseProcessModelConfigPatch>;
				try {
					patch = parseProcessModelConfigPatch(req.body);
					if (preview) {
						const prepared = prepareProcessModelConfig({
							process,
							patch,
							policy,
							availability: cache.snapshot(),
						});
						return { modelConfiguration: prepared.modelConfiguration };
					}
				} catch (error) {
					return reply.code(400).send({
						error: error instanceof Error ? error.message : "Invalid model configuration",
					});
				}
				const result = await deps.processEngine.run(UpdateModelConfig, {
					instanceId: process.id,
					patch,
					actor: resolveActor(req),
				});
				if (!result.ok)
					return reply
						.code(
							result.code === "process_not_found"
								? 404
								: result.stage === "post_commit"
									? 500
									: 400,
						)
						.send({ error: result.message });
				// The engine has released its process lock. Future execution coordination must come after it.
				await reconcileFutureExecutionModelBlocks({
					...deps,
					processGraphs: deps.processGraphs,
					processActionRegistry: deps.processActionRegistry,
					policy,
					availability: cache.snapshot(),
					getModelAvailabilitySnapshot: () => cache.snapshot(),
					instanceId: process.id,
					asOf: new Date().toISOString(),
				});
				return result.data;
			},
		});
	}
}
