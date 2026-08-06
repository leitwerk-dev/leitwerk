import type { FastifyInstance } from "fastify";
import { registerFutureExecutionRoutes } from "./future-executions.js";
import { registerLauncherRoutes } from "./launchers.js";
import { registerProcessActionRoutes } from "./process-actions.js";
import { registerProcessDetailRoutes } from "./process-detail.js";
import { registerProcessQuestionRoutes } from "./process-questions.js";
import type { RouteDeps } from "./process-route-helpers.js";
import { registerProcessSessionRoutes } from "./process-session.js";

export type { RouteDeps } from "./process-route-helpers.js";

export function registerProcessRoutes(app: FastifyInstance, deps: RouteDeps) {
	registerProcessDetailRoutes(app, deps);
	registerLauncherRoutes(app, deps, deps.futureExecutionLifecycle);
	registerFutureExecutionRoutes(app, deps, deps.futureExecutionLifecycle);
	registerProcessActionRoutes(app, deps, deps.futureExecutionLifecycle);
	registerProcessQuestionRoutes(app, deps);
	registerProcessSessionRoutes(app, deps);
}
