import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "./database.js";
import { createFutureExecutionRepo, createProcessInstanceRepo } from "./repositories.js";

describe("future execution repo", () => {
	it("creates, updates, and lists scheduled items", () => {
		const db = createInMemoryDatabase();
		const repo = createFutureExecutionRepo(db);
		const created = repo.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "demo_process",
			launcherId: "demo.launcher",
			payloadJson: JSON.stringify({ hello: "world" }),
			nextRunAt: "2026-04-25T09:00:00.000Z",
		});

		expect(repo.getById(created.id)).toMatchObject({
			kind: "launch",
			scheduleKind: "once",
			launcherId: "demo.launcher",
		});

		const updated = repo.update(created.id, {
			scheduleKind: "cron",
			cronExpression: "0 9 * * 1-5",
			nextRunAt: "2026-04-27T09:00:00.000Z",
		});
		expect(updated).toMatchObject({
			scheduleKind: "cron",
			cronExpression: "0 9 * * 1-5",
		});
		expect(repo.listAll()).toHaveLength(1);
		expect(repo.listDue("2026-04-27T09:00:00.000Z")).toHaveLength(1);
	});

	it("round-trips provenance and keeps blocked one-time rows out of runnable due work", () => {
		const db = createInMemoryDatabase();
		const repo = createFutureExecutionRepo(db);
		const selection = {
			modelProfileId: "profile-a",
			provenance: { kind: "explicit" as const, source: "action_override" as const },
		};
		const blockedReason = {
			code: "model_unavailable" as const,
			selection,
			summary: "Provider credentials are unavailable",
			detectedAt: "2026-04-25T08:00:00.000Z",
			availabilityRevision: 4,
		};
		const created = repo.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "demo_process",
			launcherId: "demo.launcher",
			payloadJson: "{}",
			nextRunAt: "2026-04-25T09:00:00.000Z",
			modelSelection: selection,
			blockedReason,
		});
		expect(repo.getById(created.id)).toMatchObject({ modelSelection: selection, blockedReason });
		expect(repo.listDue("2026-04-25T09:00:00.000Z")).toEqual([]);
		expect(repo.update(created.id, { blockedReason: null })).toMatchObject({
			blockedReason: null,
		});
		expect(repo.listRunnableDue("2026-04-25T09:00:00.000Z")).toHaveLength(1);
	});

	it("round-trips catalog-only block reasons without an availability revision", () => {
		const db = createInMemoryDatabase();
		const repo = createFutureExecutionRepo(db);
		const blockedReason = {
			code: "invalid_model_configuration" as const,
			selection: null,
			summary: "Saved model configuration is invalid",
			detectedAt: "2026-04-25T08:00:00.000Z",
		};
		const created = repo.create({
			kind: "launch",
			scheduleKind: "once",
			processId: "demo_process",
			launcherId: "demo.launcher",
			payloadJson: "{}",
			nextRunAt: "2026-04-25T09:00:00.000Z",
			blockedReason,
		});

		expect(repo.getById(created.id)?.blockedReason).toEqual(blockedReason);
	});

	it("separates runnable scheduled launches from blocked needs-attention launches", () => {
		const db = createInMemoryDatabase();
		const repo = createFutureExecutionRepo(db);
		const base = {
			kind: "launch" as const,
			scheduleKind: "once" as const,
			processId: "demo_process",
			launcherId: "demo.launcher",
			payloadJson: "{}",
			nextRunAt: "2026-04-25T09:00:00.000Z",
		};
		repo.create(base);
		repo.create({
			...base,
			blockedReason: {
				code: "model_required",
				selection: null,
				summary: "Choose a model",
				detectedAt: "2026-04-25T08:00:00.000Z",
				availabilityRevision: 1,
			},
		});
		expect(repo.countOverview({ status: "all" })).toBe(2);
		expect(repo.countOverview({ status: "scheduled" })).toBe(1);
		expect(repo.countOverview({ status: "needs_attention" })).toBe(1);
	});

	it("tracks one scheduled action per process instance", () => {
		const db = createInMemoryDatabase();
		const processes = createProcessInstanceRepo(db);
		const repo = createFutureExecutionRepo(db);
		const process = processes.create({ processId: "demo_process" });
		const created = repo.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: JSON.stringify({ input: {} }),
			nextRunAt: "2026-04-25T10:00:00.000Z",
		});

		expect(repo.getScheduledActionByInstance(process.id)?.id).toBe(created.id);
		expect(repo.listByInstance(process.id)).toHaveLength(1);
		expect(() =>
			repo.create({
				kind: "action",
				scheduleKind: "once",
				processId: process.processId,
				instanceId: process.id,
				actionId: "request_changes",
				payloadJson: JSON.stringify({ input: {} }),
				nextRunAt: "2026-04-25T11:00:00.000Z",
			}),
		).toThrow(/unique|constraint/i);
		expect(repo.delete(created.id)).toBe(true);
		expect(repo.getScheduledActionByInstance(process.id)).toBeNull();
	});
});
