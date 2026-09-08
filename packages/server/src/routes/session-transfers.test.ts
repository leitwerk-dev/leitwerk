import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionTransferService } from "../session-transfer-service.js";
import { registerSessionTransferRoutes } from "./session-transfers.js";

const apps: ReturnType<typeof Fastify>[] = [];

async function makeApp(
	service: Partial<SessionTransferService>,
	publicBaseUrl = "https://leitwerk.example/base/",
) {
	const app = Fastify();
	apps.push(app);
	registerSessionTransferRoutes(app, service as SessionTransferService, publicBaseUrl);
	await app.ready();
	return app;
}

afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("session transfer routes", () => {
	it("builds links from the configured deployment origin and keeps the token in the fragment", async () => {
		const createGrant = vi.fn(async () => ({
			kind: "created" as const,
			grantId: "trg_1",
			rawToken: "secret-token",
			expiresAt: "2026-09-01T01:00:00.000Z",
		}));
		const app = await makeApp({ createGrant });
		const response = await app.inject({
			method: "POST",
			url: "/api/processes/agt_1/session-transfers",
			headers: { host: "attacker.example", "x-forwarded-host": "attacker.example" },
		});

		expect(response.statusCode).toBe(201);
		expect(response.json()).toEqual({
			transferUrl: "https://leitwerk.example/api/session-transfers/agt_1/trg_1#token=secret-token",
			expiresAt: "2026-09-01T01:00:00.000Z",
		});
		expect(response.body).not.toContain("attacker.example");
	});

	it("does not mint a grant when the configured deployment URL is insecure", async () => {
		const createGrant = vi.fn();
		const app = await makeApp({ createGrant }, "http://leitwerk.example");
		const response = await app.inject({
			method: "POST",
			url: "/api/processes/agt_1/session-transfers",
		});
		expect(response.statusCode).toBe(503);
		expect(response.json()).toMatchObject({ code: "transfer_requires_https" });
		expect(createGrant).not.toHaveBeenCalled();
	});

	it("returns indistinguishable not-found responses when bearer authentication is absent", async () => {
		const startAttempt = vi.fn();
		const app = await makeApp({ startAttempt });
		const response = await app.inject({
			method: "POST",
			url: "/api/session-transfers/agt_1/trg_1/attempts",
		});
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({ error: "Transfer not found" });
		expect(startAttempt).not.toHaveBeenCalled();
	});
});
