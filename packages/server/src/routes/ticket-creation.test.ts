import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationToolRegistry } from "../integration-tool-registry.js";
import type { RouteDeps } from "./process-route-helpers.js";
import { registerTicketCreationRoutes } from "./ticket-creation.js";

const apps: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => {
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

function ticketCapability(overrides: Record<string, unknown> = {}) {
	return {
		kind: "ticket_creation" as const,
		displayName: "Tracker",
		processId: "ticket_creation_process",
		startTurnId: "create_ticket",
		...overrides,
	};
}

function appWith(
	deps: Partial<RouteDeps>,
	registry: Partial<IntegrationToolRegistry>,
): ReturnType<typeof Fastify> {
	const app = Fastify();
	apps.push(app);
	registerTicketCreationRoutes(
		app,
		{
			processGraphs: new Map([["ticket_creation_process", {}]]) as RouteDeps["processGraphs"],
			...deps,
		} as RouteDeps,
		registry as IntegrationToolRegistry,
	);
	return app;
}

const ticketPayload = {
	artifact: { kind: "turn_result", turnRecordId: "turn-1" },
	focus: { kind: "whole_result" },
	toolName: "tracker_create_ticket",
} as const;

function parentContextDeps(): Partial<RouteDeps> {
	return {
		processes: {
			getById: vi.fn(() => ({ id: "parent-1", title: "Parent", paramsJson: "{}" })),
		} as never,
		turnRecords: {
			listByInstance: vi.fn(() => [
				{
					id: "turn-1",
					status: "succeeded",
					turnResultMarkdown: "Durable result",
					startedAt: "2026-08-23T00:00:00Z",
				},
			]),
		} as never,
	};
}

function ticketRelation() {
	return {
		parentInstanceId: "parent-1",
		childInstanceId: "child-1",
		kind: "derived" as const,
		purpose: "ticket_creation",
		createdAt: "2026-08-23T00:00:01Z",
		createdBy: { id: "system", kind: "system" as const },
	};
}

describe("ticket creation routes", () => {
	it("requires an idempotency key", async () => {
		const app = appWith({}, { ticketCatalog: () => [] });
		const response = await app.inject({
			method: "POST",
			url: "/api/processes/parent-1/ticket-creation",
			payload: ticketPayload,
		});
		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual({ error: "Idempotency-Key header is required" });
	});

	it("rejects launch before admission when the ticket process is unavailable", async () => {
		const resolveTicketTool = vi.fn(() => ({ capability: ticketCapability() }));
		const startPreparedPlan = vi.fn();
		const app = appWith(
			{
				processGraphs: new Map() as RouteDeps["processGraphs"],
				launchCoordinator: { startPreparedPlan } as never,
			},
			{ ticketCatalog: () => [], resolveTicketTool },
		);
		const response = await app.inject({
			method: "POST",
			url: "/api/processes/parent-1/ticket-creation",
			headers: { "idempotency-key": "ticket:1" },
			payload: ticketPayload,
		});
		expect(response.statusCode).toBe(503);
		expect(resolveTicketTool).toHaveBeenCalledWith("tracker_create_ticket");
		expect(startPreparedPlan).not.toHaveBeenCalled();
	});

	it("admits the extension-owned process target and relation through the launch coordinator", async () => {
		const relation = ticketRelation();
		const startPreparedPlan = vi.fn(async () => ({
			launchRunId: "launch-1",
			process: { id: "child-1" },
			error: null,
		}));
		const app = appWith(
			{
				...parentContextDeps(),
				processGraphs: new Map([["extension_ticket_process", {}]]) as RouteDeps["processGraphs"],
				launchCoordinator: { startPreparedPlan } as never,
				processRelations: { getByChild: vi.fn(() => relation) } as never,
			},
			{
				ticketCatalog: () => [],
				resolveTicketTool: vi.fn(() => ({
					capability: ticketCapability({
						processId: "extension_ticket_process",
						startTurnId: "draft_ticket",
					}),
				})),
			},
		);
		const response = await app.inject({
			method: "POST",
			url: "/api/processes/parent-1/ticket-creation",
			headers: { "idempotency-key": "ticket:1" },
			payload: ticketPayload,
		});

		expect(response.statusCode).toBe(200);
		expect(startPreparedPlan).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "ticket:1",
				origin: "ui",
				launchPlan: expect.objectContaining({
					launcherId: "ticket:tracker_create_ticket",
					processId: "extension_ticket_process",
					startTurnId: "draft_ticket",
				}),
				relation: expect.objectContaining({
					parentInstanceId: "parent-1",
					purpose: "ticket_creation",
				}),
			}),
		);
		expect(response.json()).toEqual({ childInstanceId: "child-1", relation });
	});

	it("defers destination selection to the child process", async () => {
		const relation = ticketRelation();
		const startPreparedPlan = vi.fn(async () => ({
			launchRunId: "launch-1",
			process: { id: "child-1" },
			error: null,
		}));
		const app = appWith(
			{
				...parentContextDeps(),
				launchCoordinator: { startPreparedPlan } as never,
				processRelations: { getByChild: vi.fn(() => relation) } as never,
			},
			{
				ticketCatalog: () => [],
				resolveTicketTool: vi.fn(() => ({
					capability: ticketCapability({ destinations: {} }),
				})),
				listTicketDestinations: vi.fn(async () => ({
					destinations: [{ id: "repo-1", displayName: "team/repo" }],
					warnings: ["A secondary profile is unavailable"],
				})),
			},
		);
		const response = await app.inject({
			method: "POST",
			url: "/api/processes/parent-1/ticket-creation",
			headers: { "idempotency-key": "ticket:1" },
			payload: {
				...ticketPayload,
				additionalInstructions: "Create an issue for the mobile composer",
			},
		});

		expect(response.statusCode).toBe(200);
		const launchPlan = startPreparedPlan.mock.calls[0]?.[0].launchPlan;
		const params = JSON.parse(launchPlan.processInput.paramsJson);
		expect(launchPlan.processInput.metadata).toEqual({
			_leitwerk: { requiresExternalReceipt: true },
		});
		expect(params.ticketDestination).toBeUndefined();
		expect(params.ticketDestinations).toEqual([{ id: "repo-1", displayName: "team/repo" }]);
		expect(params.ticketDestinationWarnings).toEqual(["A secondary profile is unavailable"]);
	});
});
