import {
	type ExtensionProcessDefinition,
	emptyParamsCodec,
	flow,
	RetryableWaitError,
	type TurnWaitPredicate,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { pendingTurnWait } from "./process-engine/turn-wait-state.js";
import { createServerProcessModelPolicy } from "./process-model-policy/index.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createFakeWorkerSupervisor } from "./test-helpers/fake-worker-supervisor.js";
import { createOwnedTestDeps } from "./test-helpers/owned-test-deps.js";
import {
	createFixtureAutomaticTurn,
	createFixtureLlmTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "./test-helpers/process-fixtures.js";
import { prepareSuccessfulLlmTurnStarts } from "./test-helpers/turn-start-preflight-fixtures.js";
import { createTurnWaitService } from "./turn-wait-service.js";

function setup(
	predicate: TurnWaitPredicate<Record<string, never>, Record<string, never>>,
	kind: "automatic" | "llm" = "automatic",
	definitionOverride?: ExtensionProcessDefinition<Record<string, never>, Record<string, never>>,
) {
	const deps = createOwnedTestDeps();
	const definition =
		definitionOverride ??
		createFixtureProcess({
			id: "wait_fixture",
			entry: "work",
			turns: {
				work: {
					...(kind === "automatic" ? createFixtureAutomaticTurn() : createFixtureLlmTurn("Work")),
					waitFor: predicate,
				},
			},
		});
	const processGraphs = createProcessGraphRegistry([definition]);
	const registry = buildProcessActionRegistry({ processes: processGraphs });
	const config = getDefaultConfig();
	config.pi.model_profiles = [
		{ id: "fixture-profile", provider: "fixture-provider", model_id: "fixture-model" },
	];
	const supervisor = createFakeWorkerSupervisor();
	const engine = createProcessEngine({
		...deps,
		processModelPolicy: createServerProcessModelPolicy({
			config,
			processGraphs,
			processActionRegistry: registry,
		}),
		getModelAvailabilitySnapshot: () => ({
			revision: 1,
			capturedAt: new Date().toISOString(),
			availabilityTransitions: [],
			profiles: [
				{
					profileId: "fixture-profile",
					providerId: "fixture-provider",
					modelId: "fixture-model",
					availability: "available",
					checkedAt: new Date().toISOString(),
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
				},
			],
		}),
		processGraphs,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => supervisor,
		getProcessActionRegistry: () => registry,
		prepareTurnStarts: prepareSuccessfulLlmTurnStarts(),
	});
	const process = deps.processes.create({
		processId: definition.id,
		defaultModelProfileId: "fixture-profile",
		paramsJson: "{}",
		stateJson: "{}",
	});
	let time = 1_000;
	const service = () =>
		createTurnWaitService({
			...deps,
			processGraphs,
			registry,
			commands: engine,
			require() {
				throw new Error("No test adapters");
			},
			now: () => time,
			pollIntervalMs: 100,
			timeoutMs: 50,
		});
	const read = () => {
		const current = deps.processes.getById(process.id);
		if (!current) throw new Error("Process disappeared");
		return current;
	};
	const counts = () => [
		deps.turnStarts.listByInstance(process.id).length,
		deps.turnRecords.listByInstance(process.id).length,
		deps.leases.listByInstance(process.id).length,
		supervisor.spawnCalls.length,
	];
	return {
		deps,
		process,
		engine,
		supervisor,
		service,
		read,
		counts,
		advance(ms = 100) {
			time += ms;
		},
		start: () => engine.startProcess(process.id, "work"),
	};
}

describe("server-owned turn readiness", () => {
	it("waits before freezing mapped items and preserves the next gate after an empty collection", async () => {
		let ready = false;
		const predicate = () => ready;
		const items = vi.fn(() => [] as number[]);
		const numberCodec = {
			parse: (value: unknown) => Number(value),
			serialize: (value: number) => value,
		};
		const definition = flow
			.process<Record<string, never>, Record<string, never>>("wait_fixture")
			.displayName("Mapped readiness")
			.entry("work")
			.codecs({ params: emptyParamsCodec, state: emptyParamsCodec })
			.initialState(() => ({}))
			.turn(
				flow
					.llm<Record<string, never>, Record<string, never>>("work")
					.description("Map")
					.waitFor(predicate)
					.forEach<number, number>({
						items,
						itemCodec: numberCodec,
						resultCodec: numberCodec,
						key: ({ item }) => String(item),
					})
					.buildPrompt(() => "Review the item")
					.outcomeTool("done", (o) => o.description("Done").yield(({ ctx }) => ctx.item))
					.collect(({ state }) => state)
					.to("follow"),
			)
			.turn(
				flow
					.automatic<Record<string, never>, Record<string, never>>("follow")
					.description("Follow")
					.waitFor(() => false)
					.run(() => ({ outcome: "done" }))
					.outcome("done", (o) => o.description("Done").complete()),
			)
			.define();
		const s = setup(predicate, "llm", definition);
		await s.start();
		const service = s.service();
		await service.poll();
		expect(items).not.toHaveBeenCalled();
		ready = true;
		s.advance();
		await service.poll();
		expect(items).toHaveBeenCalledTimes(1);
		expect(s.read()).toMatchObject({
			selectedTurnId: "follow",
			lifecycleStatus: "waiting",
			currentExecution: null,
		});
		expect(pendingTurnWait(s.read())?.turnId).toBe("follow");
		await service.poll();
		expect(s.counts()).toEqual([0, 0, 0, 0]);
	});
	it.each([
		"automatic",
		"llm",
	] as const)("keeps repeated false checks out of %s starts, leases and attempts", async (kind) => {
		const predicate = vi.fn(() => false);
		const s = setup(predicate, kind);
		expect(await s.start()).toMatchObject({
			ok: true,
			process: { lifecycleStatus: "waiting", currentExecution: null },
		});
		const service = s.service();
		for (let i = 0; i < 10; i++) {
			await service.poll();
			s.advance();
		}
		expect(predicate).toHaveBeenCalledTimes(10);
		expect(s.counts()).toEqual([0, 0, 0, 0]);
	});

	it("completes a closed external subject without a worker", async () => {
		const s = setup((process) => process.complete());
		await s.start();
		await s.service().poll();
		expect(s.read()).toMatchObject({
			lifecycleStatus: "completed",
			selectedTurnId: null,
			currentExecution: null,
		});
		expect(pendingTurnWait(s.read())).toBeNull();
		expect(s.counts()).toEqual([0, 0, 0, 0]);
	});

	it.each([
		"automatic",
		"llm",
	] as const)("admits one %s start after a single flight and stops checking once admitted", async (kind) => {
		const gate = Promise.withResolvers<boolean>();
		const predicate = vi.fn(() => gate.promise);
		const s = setup(predicate, kind);
		await s.start();
		const service = s.service();
		const a = service.check(s.process.id);
		const b = service.check(s.process.id);
		expect(a).toBe(b);
		gate.resolve(true);
		await Promise.all([a, b]);
		expect(s.read()).toMatchObject({
			lifecycleStatus: "active",
			currentExecution: { kind: "worker_start" },
		});
		expect(s.counts()).toEqual([1, 0, 0, 1]);
		await service.poll();
		expect(predicate).toHaveBeenCalledTimes(1);
	});

	it("preserves transient backoff when the readiness service restarts", async () => {
		const predicate = vi.fn(() => {
			throw new RetryableWaitError("Provider unavailable");
		});
		const s = setup(predicate);
		await s.start();
		const first = s.service();
		await first.poll();
		first.stop();
		expect(pendingTurnWait(s.read())).toMatchObject({
			failures: 1,
			message: "Provider unavailable",
		});
		expect(s.read().lifecycleStatus).toBe("waiting");
		const recovered = s.service();
		await recovered.poll();
		s.advance(200);
		await recovered.poll();
		expect(predicate).toHaveBeenCalledTimes(2);
		expect(s.counts()).toEqual([0, 0, 0, 0]);
		expect(
			s.deps.events.listByInstance(s.process.id).filter((e) => e.eventType === "turn_wait_failed"),
		).toHaveLength(1);
	});

	it("parks a broken predicate with diagnostics until an explicit retry checks it again", async () => {
		let broken = true;
		const predicate = vi.fn(() => {
			if (broken) throw new Error("Invalid profile");
			return false;
		});
		const s = setup(predicate);
		await s.start();
		const service = s.service();
		await service.poll();
		expect(s.read().lifecycleStatus).toBe("error");
		await service.poll();
		expect(predicate).toHaveBeenCalledTimes(1);
		broken = false;
		expect(await s.engine.retryProcess(s.process.id)).toMatchObject({ ok: true });
		await service.poll();
		expect(s.read().lifecycleStatus).toBe("waiting");
		expect(predicate).toHaveBeenCalledTimes(2);
		expect(s.counts()).toEqual([0, 0, 0, 0]);
	});

	it.each([
		"stop",
		"state",
		"params",
		"project",
	] as const)("rejects late readiness after a %s change", async (change) => {
		const gate = Promise.withResolvers<boolean>();
		const entered = Promise.withResolvers<void>();
		const s = setup(() => {
			entered.resolve();
			return gate.promise;
		});
		await s.start();
		const check = s.service().check(s.process.id);
		await entered.promise;
		if (change === "stop") await s.engine.abortProcess(s.process.id);
		if (change === "state") s.deps.processes.update(s.process.id, { stateJson: '{"new":true}' });
		if (change === "params") s.deps.processes.update(s.process.id, { paramsJson: '{"new":true}' });
		if (change === "project")
			s.deps.projects.create({
				instanceId: s.process.id,
				key: "repo",
				repoLocator: "https://example.test/repo.git",
				baseBranch: "main",
			});
		gate.resolve(true);
		await check;
		expect(s.counts()).toEqual([0, 0, 0, 0]);
	});

	it("checks readiness again for an accepted failed-turn retry without losing lineage", async () => {
		let ready = false;
		const s = setup(() => ready);
		s.deps.processes.update(s.process.id, { selectedTurnId: "work", lifecycleStatus: "error" });
		const failed = s.deps.turnRecords.create({
			instanceId: s.process.id,
			turnId: "work",
			turnType: "automatic",
			status: "failed",
		});
		expect(await s.engine.retryProcess(s.process.id)).toMatchObject({
			ok: true,
			process: { lifecycleStatus: "waiting" },
		});
		const service = s.service();
		await service.poll();
		expect(s.counts()).toEqual([1, 1, 1, 0]);
		ready = true;
		s.advance();
		await service.poll();
		expect(s.counts()).toEqual([2, 1, 1, 1]);
		const current = s.read().currentExecution;
		expect(current?.kind).toBe("worker_start");
		expect(s.deps.turnStarts.getById(current?.id ?? "")).toMatchObject({
			startKind: "retry",
			recoveryTurnRecordId: failed.id,
		});
	});

	it("times out hung reads and cancels them promptly on shutdown", async () => {
		const s = setup(() => new Promise(() => {}));
		await s.start();
		const service = s.service();
		await service.poll();
		expect(pendingTurnWait(s.read())?.message).toContain("timed out");
		s.advance(200);
		const check = service.check(s.process.id);
		await Promise.resolve();
		service.stop();
		await check;
		expect(s.counts()).toEqual([0, 0, 0, 0]);
	});
});
