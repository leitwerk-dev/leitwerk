import type { FastifyInstance } from "fastify";
import type { AuthService } from "../auth/auth-service.js";
import { requireApiActor } from "../auth/fastify-auth.js";
import { registerAuthRoutes } from "../auth/routes.js";
import type { ExtensionUiCatalog } from "../extension-ui/catalog.js";
import type { ProcessSessionSnapshotStore } from "../process-session-store.js";
import type { ResultImageStore } from "../result-image-store.js";
import { registerInternalWorkerSessionSnapshotRoutes } from "../routes/internal-worker-session-snapshot.js";
import { type RouteDeps, registerProcessRoutes } from "../routes/processes.js";
import { registerResultImageRoutes } from "../routes/result-images.js";
import { registerSkillRoutes } from "../routes/skills.js";
import { registerUiRendererRoutes } from "../routes/ui-renderers.js";
import { registerWatcherRoutes } from "../routes/watchers.js";
import { healthBody } from "./register-websocket.js";

export function registerHttp(input: {
	app: FastifyInstance;
	deps: RouteDeps;
	processWatcherService: Parameters<typeof registerWatcherRoutes>[1]["processWatchers"];
	extensionUiCatalog: ExtensionUiCatalog;
	authService: AuthService;
	sessionSnapshots: ProcessSessionSnapshotStore;
	resultImages: ResultImageStore;
	maxSessionSnapshotBytes?: number;
	extensionUiAssetCacheControl?: string;
}): void {
	input.app.get("/api/health", async () => healthBody());
	registerInternalWorkerSessionSnapshotRoutes({
		app: input.app,
		leases: input.deps.leases,
		processes: input.deps.processes,
		turnStarts: input.deps.turnStarts,
		turnRecords: input.deps.turnRecords,
		skills: input.deps.skills,
		sessionSnapshots: input.sessionSnapshots,
		maxSnapshotBytes: input.maxSessionSnapshotBytes,
	});
	registerAuthRoutes(input.app, input.authService);
	input.app.addHook("preHandler", async (request, reply) => {
		const url = request.url.split("?", 1)[0] ?? request.url;
		if (!url.startsWith("/api/") || url === "/api/health" || url === "/api/auth/me") {
			return;
		}
		requireApiActor(input.authService, request, reply);
	});
	registerResultImageRoutes({
		app: input.app,
		deps: input.deps,
		store: input.resultImages,
	});
	registerProcessRoutes(input.app, input.deps);
	registerWatcherRoutes(input.app, { processWatchers: input.processWatcherService });
	if (input.deps.skillCatalog) {
		registerSkillRoutes(input.app, { skillCatalog: input.deps.skillCatalog });
	}
	registerUiRendererRoutes(input.app, {
		extensionUiCatalog: input.extensionUiCatalog,
		extensionUiAssetCacheControl: input.extensionUiAssetCacheControl,
	});
}
