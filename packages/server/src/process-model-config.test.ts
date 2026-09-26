import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import Fastify from "fastify";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { closeDatabase } from "./db/database.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { UpdateModelConfig } from "./process-engine/ops/update-model-config.js";
import { UpdateProductRefs } from "./process-engine/ops/update-product-refs.js";
import { parseProcessModelConfigPatch, prepareProcessModelConfig } from "./process-model-config.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { registerProcessModelConfigRoutes } from "./routes/process-model-config.js";
import type { RouteDeps } from "./routes/process-route-helpers.js";
import { createOwnedTestDeps } from "./test-helpers/owned-test-deps.js";
import {
	createModelAvailabilitySnapshot,
	createTestModelPolicy,
	createTestProcessInstance,
	createTestTurnStart,
} from "./test-helpers/process-model-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const availability = createModelAvailabilitySnapshot();
function prepare(
	patch: Parameters<typeof prepareProcessModelConfig>[0]["patch"],
	options: Parameters<typeof createTestModelPolicy>[0] = {},
	process = createTestProcessInstance(),
) {
	return prepareProcessModelConfig({
		patch,
		process,
		policy: createTestModelPolicy(options).policy,
		availability,
	});
}

describe("instance model configuration", () => {
	it("sets, clears, and preserves sparse settings with configured step precedence", () => {
		const process = createTestProcessInstance({
			defaultModelProfileId: "first",
			turnConfigsJson: '{"run":{"modelProfileId":"second"}}',
		});
		const changed = prepare({ defaultModelProfileId: "second" }, {}, process);
		expect(changed.settings.turnConfigsJson).toBe(process.turnConfigsJson);
		const cleared = prepare(
			{ turnConfigs: { run: { modelProfileId: null } } },
			{ processTurnProfileId: "second" },
			process,
		);
		expect(cleared.settings.defaultModelProfileId).toBe("first");
		expect(cleared.modelConfiguration.turns[0]).toMatchObject({
			instanceModelProfileId: null,
			effectiveConfiguredModelProfileId: "second",
			source: "process_config",
		});
		expect(
			prepare({ defaultModelProfileId: null }, {}, process).modelConfiguration.defaultModel,
		).toMatchObject({ source: "catalog_default", instanceModelProfileId: null });
	});
	it.each([
		null,
		[],
		{ defaultModelProfileId: "" },
		{ turnConfigs: { run: null } },
		{ turnConfigs: { run: { modelProfileId: 5 } } },
		{ other: "first" },
	])("rejects malformed sparse patches: %j", (value) => {
		expect(() => parseProcessModelConfigPatch(value)).toThrow();
	});
	it("rejects unknown, disallowed, unavailable, fixed and non-model steps", () => {
		expect(() => prepare({ defaultModelProfileId: "missing" })).toThrow("Unknown");
		expect(() =>
			prepare({ defaultModelProfileId: "second" }, { allowedProfileIds: ["first"] }),
		).toThrow("not allowed");
		expect(() => prepare({ turnConfigs: { absent: { modelProfileId: null } } })).toThrow(
			"unknown or does not use a model",
		);
		expect(() =>
			prepare(
				{ turnConfigs: { run: { modelProfileId: "second" } } },
				{ purposeProfileId: "first" },
			),
		).toThrow("fixed system model");
		expect(() =>
			prepareProcessModelConfig({
				process: createTestProcessInstance(),
				patch: { defaultModelProfileId: "second" },
				policy: createTestModelPolicy().policy,
				availability: createModelAvailabilitySnapshot([
					{ profileId: "second", availability: "unavailable" },
				]),
			}),
		).toThrow("unavailable");
	});
	it.each([
		"completed",
		"aborted",
	] as const)("rejects %s and malformed saved configuration", (lifecycleStatus) => {
		expect(() => prepare({}, {}, createTestProcessInstance({ lifecycleStatus }))).toThrow(
			"read-only",
		);
		expect(() =>
			prepare({}, {}, createTestProcessInstance({ turnConfigsJson: "invalid" })),
		).toThrow("malformed");
	});
	it.each([
		"instance_default",
		"instance_turn_config",
		"catalog_default",
	] as const)("retries resolve updated settings for %s without changing active labels", (source) => {
		const policy = createTestModelPolicy().policy;
		const process = createTestProcessInstance({
			defaultModelProfileId: "second",
			selectedTurnModelProfileId: "first",
			selectedTurnModelSource: source,
			selectedTurnModelKind: source === "catalog_default" ? "inherited" : "explicit",
		});
		expect(
			policy.evaluate({
				kind: "process_turn",
				process,
				turnId: "run",
				startKind: "retry",
				availability,
			}),
		).toMatchObject({ selection: { modelProfileId: "second" } });
		expect(
			policy.project({ kind: "process_configuration", process, availability }).effectiveSelectedTurn
				?.modelProfileId,
		).toBe("first");
	});
	it.each([
		"action_override",
		"launch_override",
	] as const)("preserves one-time %s on retry", (source) => {
		const process = createTestProcessInstance({
			defaultModelProfileId: "second",
			selectedTurnModelProfileId: "first",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: source,
		});
		expect(
			createTestModelPolicy().policy.evaluate({
				kind: "process_turn",
				process,
				turnId: "run",
				startKind: "retry",
				availability,
			}),
		).toMatchObject({ selection: { modelProfileId: "first" } });
	});
});

function harness(sqlitePath?: string) {
	const deps = createTestDeps({ sqlitePath });
	onTestFinished(() => {
		if (deps.db.$client.isOpen) closeDatabase(deps.db);
	});
	const model = createTestModelPolicy();
	const processOperations = createProcessOperationCoordinator();
	const engine = createProcessEngine({
		...deps,
		processGraphs: model.graph,
		processOperations,
		getSupervisor: () => undefined,
		processModelPolicy: model.policy,
		getModelAvailabilitySnapshot: () => availability,
	});
	return { deps, model, engine, processOperations };
}

describe("model configuration durable operation and HTTP", () => {
	it("serializes sparse concurrent saves, attributes audit, and preserves prepared execution across restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "model-config-"));
		onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
		const path = join(dir, "process.sqlite");
		const { deps, engine } = harness(path);
		const process = deps.processes.create({
			processId: "policy",
			selectedTurnId: "run",
			lifecycleStatus: "active",
			defaultModelProfileId: "first",
			selectedTurnModelProfileId: "first",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "instance_default",
		});
		const {
			id: _,
			createdAt: __,
			updatedAt: ___,
			...startInput
		} = createTestTurnStart({ instanceId: process.id });
		const start = deps.turnStarts.create(startInput);
		deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
		const before = deps.processes.getById(process.id);
		if (!before) throw new Error("Missing process");
		const broadcast = vi.spyOn(deps.broadcaster, "broadcast");
		const results = await Promise.all([
			engine.run(UpdateModelConfig, {
				instanceId: process.id,
				actor: SYSTEM_ACTOR,
				patch: { defaultModelProfileId: "second" },
			}),
			engine.run(UpdateModelConfig, {
				instanceId: process.id,
				actor: SYSTEM_ACTOR,
				patch: { turnConfigs: { run: { modelProfileId: "first" } } },
			}),
			engine.run(UpdateProductRefs, {
				instanceId: process.id,
				patch: { test: { entryId: "entry", turnRecordId: null } },
			}),
		]);
		expect(results.every((result) => result.ok)).toBe(true);
		const saved = deps.processes.getById(process.id);
		if (!saved) throw new Error("Missing process");
		expect(saved).toMatchObject({
			defaultModelProfileId: "second",
			turnConfigsJson: '{"run":{"modelProfileId":"first"}}',
			lifecycleStatus: before.lifecycleStatus,
			planRevision: before.planRevision,
			currentExecution: before.currentExecution,
			selectedTurnModelProfileId: "first",
			initialDefaultModelProfileId: before.initialDefaultModelProfileId,
		});
		expect(deps.turnStarts.getById(start.id)).toEqual(start);
		expect(
			deps.events
				.listByInstance(process.id)
				.filter((event) => event.eventType === "model_configuration_changed"),
		).toHaveLength(2);
		expect(
			deps.events
				.listByInstance(process.id)
				.find((event) => event.eventType === "model_configuration_changed")?.data,
		).toMatchObject({ actor: SYSTEM_ACTOR });
		expect(broadcast).toHaveBeenCalled();
		closeDatabase(deps.db);
		const reopened = createOwnedTestDeps({ sqlitePath: path });
		expect(reopened.processes.getById(process.id)).toEqual(saved);
	});
	it("previews without saving and saves through the same validation", async () => {
		const { deps, model, engine, processOperations } = harness();
		const app = Fastify();
		onTestFinished(() => app.close());
		registerProcessModelConfigRoutes(app, {
			...deps,
			processEngine: engine,
			processOperations,
			processGraphs: model.graph,
			processActionRegistry: model.processActionRegistry,
			processModelPolicy: model.policy,
			modelStatusCache: { snapshot: () => availability },
		} as unknown as RouteDeps);
		const process = deps.processes.create({ processId: "policy" });
		const url = `/api/processes/${process.id}/model-config`;
		const preview = await app.inject({
			method: "POST",
			url: `${url}/preview`,
			payload: { defaultModelProfileId: "second" },
		});
		expect(preview.statusCode).toBe(200);
		expect(deps.processes.getById(process.id)?.defaultModelProfileId).toBeNull();
		const saved = await app.inject({
			method: "PATCH",
			url,
			payload: { defaultModelProfileId: "second" },
		});
		expect(saved.statusCode).toBe(200);
		expect(saved.json()).toEqual(preview.json());
		expect(
			(await app.inject({ method: "PATCH", url, payload: { defaultModelProfileId: "missing" } }))
				.statusCode,
		).toBe(400);
	});
});

it("refreshes blocked inherited schedules and preserves one-time selections, payloads and times", async () => {
	const { defineProcess } = await import("@leitwerk-dev/process-sdk");
	const { serializeFutureActionPayload } = await import("@leitwerk-dev/protocol");
	const { createFixtureHumanTurn, createFixtureLlmTurn } = await import(
		"./test-helpers/process-fixtures.js"
	);
	const { buildProcessActionRegistry } = await import("./process-action-registry.js");
	const { createServerProcessModelPolicy } = await import("./process-model-policy/index.js");
	const { reconcileFutureExecutionModelBlocks } = await import(
		"./future-execution/reconciliation.js"
	);
	const processDefinition = defineProcess({
		id: "policy",
		displayName: "Policy",
		entry: "review",
		turns: {
			review: createFixtureHumanTurn({
				actions: { approve: { label: "Approve", acceptanceState: "accepted", to: "run" } },
			}),
			run: createFixtureLlmTurn("Run", { context: "fresh" }),
		},
		paramsCodec: { parse: () => ({}), serialize: (value) => value },
		stateCodec: { parse: () => ({}), serialize: (value) => value },
		initialState: () => ({}),
	});
	const deps = createOwnedTestDeps();
	const processGraphs = new Map([["policy", processDefinition]]);
	const processActionRegistry = buildProcessActionRegistry({ processes: processGraphs });
	const policy = createServerProcessModelPolicy({
		config: createTestModelPolicy().config,
		processGraphs,
		processActionRegistry,
	});
	const status = createModelAvailabilitySnapshot([
		{ profileId: "first", availability: "unavailable" },
		{ profileId: "second" },
	]);
	const processOperations = createProcessOperationCoordinator();
	const process = deps.processes.create({
		processId: "policy",
		selectedTurnId: "review",
		lifecycleStatus: "waiting",
		defaultModelProfileId: "first",
	});
	const action = processActionRegistry.listVisibleActions("policy", {
		process,
		projects: [],
		params: {},
		state: {},
	} as never)[0];
	if (!action) throw new Error("Missing action");
	const scheduled = deps.futureExecutions.create({
		kind: "action",
		scheduleKind: "once",
		instanceId: process.id,
		processId: "policy",
		actionId: action.id,
		payloadJson: serializeFutureActionPayload({
			input: { note: "keep" },
			nextTurnModelProfileId: null,
		}),
		nextRunAt: "2099-01-01T00:00:00.000Z",
	});
	const base = {
		...deps,
		processOperations,
		processGraphs,
		processActionRegistry,
		policy,
		availability: status,
		getModelAvailabilitySnapshot: () => status,
		instanceId: process.id,
		asOf: "2026-01-01T00:00:00.000Z",
	};
	await reconcileFutureExecutionModelBlocks(base);
	expect(deps.futureExecutions.getById(scheduled.id)).toMatchObject({
		modelSelection: { modelProfileId: "first", provenance: { source: "instance_default" } },
		blockedReason: { code: "model_unavailable" },
	});
	const engine = createProcessEngine({
		...deps,
		processOperations,
		processGraphs,
		processModelPolicy: policy,
		getModelAvailabilitySnapshot: () => status,
		getSupervisor: () => undefined,
	});
	expect(
		(
			await engine.run(UpdateModelConfig, {
				instanceId: process.id,
				patch: { defaultModelProfileId: "second" },
				actor: SYSTEM_ACTOR,
			})
		).ok,
	).toBe(true);
	await reconcileFutureExecutionModelBlocks(base);
	expect(deps.futureExecutions.getById(scheduled.id)).toMatchObject({
		modelSelection: { modelProfileId: "second" },
		blockedReason: null,
		payloadJson: scheduled.payloadJson,
		nextRunAt: scheduled.nextRunAt,
	});
	deps.futureExecutions.update(scheduled.id, {
		payloadJson: serializeFutureActionPayload({
			input: { note: "keep" },
			nextTurnModelProfileId: "first",
		}),
		modelSelection: {
			modelProfileId: "first",
			provenance: { kind: "explicit", source: "action_override" },
		},
	});
	await reconcileFutureExecutionModelBlocks(base);
	expect(deps.futureExecutions.getById(scheduled.id)).toMatchObject({
		modelSelection: { modelProfileId: "first", provenance: { source: "action_override" } },
		blockedReason: { code: "model_unavailable" },
		nextRunAt: scheduled.nextRunAt,
	});
});

it("preserves a pending one-time launch model and fences saves against terminal transitions", async () => {
	const { deps, engine } = harness();
	const process = deps.processes.create({
		processId: "policy",
		selectedTurnId: null,
		lifecycleStatus: "discovered",
		selectedTurnModelProfileId: "first",
		selectedTurnModelKind: "explicit",
		selectedTurnModelSource: "launch_override",
	});
	expect(
		(
			await engine.run(UpdateModelConfig, {
				instanceId: process.id,
				actor: SYSTEM_ACTOR,
				patch: { defaultModelProfileId: "second" },
			})
		).ok,
	).toBe(true);
	expect(deps.processes.getById(process.id)).toMatchObject({
		selectedTurnModelProfileId: "first",
		selectedTurnModelSource: "launch_override",
		planRevision: 0,
	});
	const [aborted, saved] = await Promise.all([
		engine.abortProcess(process.id),
		engine.run(UpdateModelConfig, {
			instanceId: process.id,
			actor: SYSTEM_ACTOR,
			patch: { defaultModelProfileId: "first" },
		}),
	]);
	expect(aborted.ok).toBe(true);
	expect(saved).toMatchObject({ ok: false, code: "invalid_model_config" });
	expect(deps.processes.getById(process.id)).toMatchObject({
		lifecycleStatus: "aborted",
		defaultModelProfileId: "second",
	});
});

it("shows an actionable error instead of falling back when configured profiles are no longer allowed", () => {
	const result = prepare(
		{ defaultModelProfileId: null },
		{
			processDefaultProfileId: "second",
			processTurnProfileId: "second",
			allowedProfileIds: ["first"],
		},
	);
	expect(result.modelConfiguration.defaultModel).toMatchObject({
		effectiveModelProfileId: "second",
		source: "process_config",
	});
	expect(result.modelConfiguration.turns[0]).toMatchObject({
		effectiveModelProfileId: "second",
		effectiveSource: "process_config_turn",
		effectiveError: expect.stringContaining("not allowed"),
	});
});
