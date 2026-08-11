import { describe, expect, it, vi } from "vitest";
import {
	createIntegrationToolRequestService,
	IntegrationToolRegistry,
} from "./integration-tool-registry.js";

function registerEcho(
	registry: IntegrationToolRegistry,
	execute = vi.fn(async (_ctx, args) => args),
) {
	registry.register({
		name: "provider_echo",
		description: "Echo provider arguments",
		parameters: { type: "object" },
		execute,
	});
	return execute;
}

describe("IntegrationToolRegistry", () => {
	it("validates declarations and rejects duplicate names", () => {
		const registry = new IntegrationToolRegistry();
		registerEcho(registry);
		expect(registry.declarations(["provider_echo"])).toEqual([
			{
				name: "provider_echo",
				description: "Echo provider arguments",
				parameters: { type: "object" },
			},
		]);
		expect(() => registerEcho(registry)).toThrow(/Duplicate/);
		expect(() =>
			registry.register({
				name: "Bad-Name",
				description: "bad",
				parameters: {},
				execute: async () => ({}),
			}),
		).toThrow(/must match/);
		expect(() =>
			registry.register({
				name: " provider_echo ",
				description: "bad",
				parameters: {},
				execute: async () => ({}),
			}),
		).toThrow(/must match/);
	});

	it("coalesces only concurrent executions by stable idempotency key", async () => {
		const registry = new IntegrationToolRegistry();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execute = registerEcho(
			registry,
			vi.fn(async (_ctx, args) => {
				await gate;
				return args;
			}),
		);
		const context = { idempotencyKey: "process:turn:call:provider_echo" } as never;

		const first = registry.execute("provider_echo", { value: 1 }, context);
		const replay = registry.execute("provider_echo", { value: 1 }, context);
		release();

		await expect(first).resolves.toEqual({ value: 1 });
		await expect(replay).resolves.toEqual({ value: 1 });
		await expect(registry.execute("provider_echo", { value: 2 }, context)).resolves.toEqual({
			value: 2,
		});
		expect(execute).toHaveBeenCalledTimes(2);
	});
});

describe("integration tool request service", () => {
	it("authorizes the active LLM turn and resolves an optional project", async () => {
		const registry = new IntegrationToolRegistry();
		const execute = registerEcho(registry);
		const process = {
			id: "instance-1",
			processId: "process-type",
			selectedTurnId: "repair",
			currentExecution: { kind: "worker_start", id: "turn-start-1" },
		};
		const turn = {
			id: "turn-record-1",
			instanceId: "instance-1",
			turnId: "repair",
			status: "running",
		};
		const project = { key: "repo" };
		const service = createIntegrationToolRequestService({
			registry,
			repos: {
				processes: { getById: () => process },
				turnRecords: { getById: () => turn },
				turnStarts: {
					getById: () => ({ state: { kind: "accepted", turnRecordId: "turn-record-1" } }),
				},
				projects: { listByInstance: () => [project] },
			} as never,
			processActionRegistry: {
				getTurnDefinition: () => ({ kind: "llm", integrationTools: ["provider_echo"] }),
			},
		});

		const result = await service.handle("instance-1", {
			turnRecordId: "turn-record-1",
			toolCallId: "tool-call-1",
			toolName: "provider_echo",
			args: { projectKey: "repo", value: 2 },
		});

		expect(result).toMatchObject({ ok: true, result: { projectKey: "repo", value: 2 } });
		expect(execute.mock.calls[0]?.[0]).toMatchObject({
			process,
			turn,
			project,
			idempotencyKey: "instance-1:turn-record-1:tool-call-1:provider_echo",
		});
	});

	it("rejects stale, unauthorized, and unknown-project calls before execution", async () => {
		const registry = new IntegrationToolRegistry();
		const execute = registerEcho(registry);
		const base = {
			registry,
			repos: {
				processes: {
					getById: () => ({
						id: "instance-1",
						processId: "process-type",
						selectedTurnId: "other",
						currentExecution: { kind: "worker_start", id: "turn-start-1" },
					}),
				},
				turnStarts: {
					getById: () => ({ state: { kind: "accepted", turnRecordId: "turn-record-1" } }),
				},
				turnRecords: {
					getById: () => ({
						id: "turn-record-1",
						instanceId: "instance-1",
						turnId: "repair",
						status: "running",
					}),
				},
				projects: { listByInstance: () => [{ key: "repo" }] },
			} as never,
			processActionRegistry: { getTurnDefinition: () => ({ kind: "llm", integrationTools: [] }) },
		};
		const payload = {
			turnRecordId: "turn-record-1",
			toolCallId: "call",
			toolName: "provider_echo",
			args: {},
		};

		await expect(
			createIntegrationToolRequestService(base).handle("instance-1", payload),
		).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/stale/) });
		expect(execute).not.toHaveBeenCalled();
	});

	it("rejects a running record from an older attempt of the selected turn", async () => {
		const registry = new IntegrationToolRegistry();
		const execute = registerEcho(registry);
		const service = createIntegrationToolRequestService({
			registry,
			repos: {
				processes: {
					getById: () => ({
						id: "instance-1",
						processId: "process-type",
						selectedTurnId: "repair",
						currentExecution: { kind: "worker_start", id: "turn-start-current" },
					}),
				},
				turnRecords: {
					getById: () => ({
						id: "turn-record-stale",
						instanceId: "instance-1",
						turnId: "repair",
						status: "running",
					}),
				},
				turnStarts: {
					getById: () => ({ state: { kind: "accepted", turnRecordId: "turn-record-current" } }),
				},
				projects: { listByInstance: () => [] },
			} as never,
			processActionRegistry: {
				getTurnDefinition: () => ({ kind: "llm", integrationTools: ["provider_echo"] }),
			},
		});

		await expect(
			service.handle("instance-1", {
				turnRecordId: "turn-record-stale",
				toolCallId: "call",
				toolName: "provider_echo",
				args: {},
			}),
		).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/stale turn record/) });
		expect(execute).not.toHaveBeenCalled();
	});
});
