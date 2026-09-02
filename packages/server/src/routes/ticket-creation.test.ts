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

describe("ticket creation routes", () => {
	it("rejects launch before creating a child when the ticket process is unavailable", async () => {
		const resolveTicketTool = vi.fn(() => ({ capability: ticketCapability() }));
		const app = appWith(
			{ processGraphs: new Map() as RouteDeps["processGraphs"] },
			{ ticketCatalog: () => [], resolveTicketTool },
		);
		const response = await app.inject({
			method: "POST",
			url: "/api/processes/parent-1/ticket-creation",
			payload: { toolName: "tracker_create_ticket" },
		});
		expect(response.statusCode).toBe(503);
		expect(resolveTicketTool).toHaveBeenCalledWith("tracker_create_ticket");
	});

	it("uses the extension-owned process target and removes a child after a pre-commit failure", async () => {
		const createProcess = vi.fn(() => ({ id: "child-1" }));
		const deleteProcess = vi.fn();
		const startProcess = vi.fn(async () => ({
			ok: false as const,
			stage: "pre_commit" as const,
			code: "operation_failed",
			message: "Process operation failed before commit",
		}));
		const repos = {
			processes: {
				create: createProcess,
				getById: vi.fn(() => ({
					id: "child-1",
					lifecycleStatus: "discovered",
					selectedTurnId: null,
					currentExecution: null,
				})),
				delete: deleteProcess,
			},
			processRelations: { create: vi.fn(() => ({ childInstanceId: "child-1" })) },
		};
		const app = appWith(
			{
				processGraphs: new Map([["extension_ticket_process", {}]]) as RouteDeps["processGraphs"],
				processes: {
					getById: vi.fn(() => ({ id: "parent-1", title: "Parent", paramsJson: "{}" })),
				},
				turnRecords: {
					listByInstance: vi.fn(() => [
						{
							id: "turn-1",
							status: "succeeded",
							turnResultMarkdown: "Durable result",
							startedAt: "2026-08-23T00:00:00Z",
						},
					]),
				},
				transaction: vi.fn((fn: (value: typeof repos) => unknown) => fn(repos)),
				processEngine: { startProcess },
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
			payload: {
				artifact: { kind: "turn_result", turnRecordId: "turn-1" },
				focus: { kind: "whole_result" },
				toolName: "tracker_create_ticket",
			},
		});
		expect(response.statusCode).toBe(500);
		expect(createProcess).toHaveBeenCalledWith(
			expect.objectContaining({ processId: "extension_ticket_process" }),
		);
		expect(startProcess).toHaveBeenCalledWith("child-1", "draft_ticket", expect.any(Object));
		expect(deleteProcess).toHaveBeenCalledWith("child-1");
	});

	it("defers destination selection to the child process", async () => {
		const createProcess = vi.fn(() => ({ id: "child-1" }));
		const repos = {
			processes: { create: createProcess },
			processRelations: { create: vi.fn(() => ({ childInstanceId: "child-1" })) },
		};
		const app = appWith(
			{
				processes: {
					getById: vi.fn(() => ({ id: "parent-1", title: "Parent", paramsJson: "{}" })),
				},
				turnRecords: {
					listByInstance: vi.fn(() => [
						{
							id: "turn-1",
							status: "succeeded",
							turnResultMarkdown: "Durable result",
							startedAt: "2026-08-23T00:00:00Z",
						},
					]),
				},
				transaction: vi.fn((fn: (value: typeof repos) => unknown) => fn(repos)),
				processEngine: { startProcess: vi.fn(async () => ({ ok: true })) },
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
			payload: {
				artifact: { kind: "turn_result", turnRecordId: "turn-1" },
				focus: { kind: "whole_result" },
				toolName: "tracker_create_ticket",
				additionalInstructions: "Create an issue for the mobile composer",
			},
		});
		expect(response.statusCode).toBe(200);
		const createInput = createProcess.mock.calls[0]?.[0];
		const params = JSON.parse(createInput.paramsJson);
		expect(createInput.metadata).toEqual({ _leitwerk: { requiresExternalReceipt: true } });
		expect(params.ticketDestination).toBeUndefined();
		expect(params.ticketDestinations).toEqual([{ id: "repo-1", displayName: "team/repo" }]);
		expect(params.ticketDestinationWarnings).toEqual(["A secondary profile is unavailable"]);
	});
});
