import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessDeletionService } from "../process-deletion-service.js";
import { registerProcessDetailRoutes } from "./process-detail.js";
import type { RouteDeps } from "./process-route-helpers.js";

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(processDeletion: ProcessDeletionService) {
	const app = Fastify();
	apps.push(app);
	registerProcessDetailRoutes(app, { processDeletion } as RouteDeps);
	await app.ready();
	return app;
}

afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("DELETE /api/processes/:instanceId", () => {
	it("returns 204 after deletion and passes the web actor", async () => {
		const deleteProcess = vi.fn(async () => ({ ok: true as const }));
		const app = await makeApp({ deleteProcess });

		const response = await app.inject({ method: "DELETE", url: "/api/processes/agt_1" });

		expect(response.statusCode).toBe(204);
		expect(response.body).toBe("");
		expect(deleteProcess).toHaveBeenCalledWith("agt_1", expect.objectContaining({ id: "admin" }));
	});

	it.each([
		{
			name: "unknown process",
			result: { ok: false as const, kind: "not_found" as const },
			status: 404,
			error: "Process not found",
		},
		{
			name: "cleanup failure",
			result: {
				ok: false as const,
				kind: "cleanup_failed" as const,
				message: "The process could not be deleted; retry deletion",
			},
			status: 500,
			error: "The process could not be deleted; retry deletion",
		},
	])("maps $name to HTTP $status", async ({ result, status, error }) => {
		const app = await makeApp({ deleteProcess: vi.fn(async () => result) });

		const response = await app.inject({ method: "DELETE", url: "/api/processes/agt_1" });

		expect(response.statusCode).toBe(status);
		expect(response.json()).toEqual({ error });
	});
});
