import {
	createEmptyStructuralProcessState,
	type ExternalActionSource,
	flow,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { createExternalSourceService } from "./external-source-service.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { accept } from "./process-engine/decision.js";
import { defineOperation } from "./process-engine/operation.js";
import { createEngineRunner } from "./process-engine/runner.js";
import type { ProcessEngine } from "./process-engine/types.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createFakeWorkerSupervisor } from "./test-helpers/fake-worker-supervisor.js";
import { createProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { prepareSuccessfulLlmTurnStarts as createSuccessfulLlmTurnStarts } from "./test-helpers/turn-start-preflight-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const stateCodec = {
	parse(value: unknown): Record<string, unknown> {
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	},
	serialize(value: Record<string, unknown>): unknown {
		return value;
	},
};

function source(overrides: Partial<ExternalActionSource> = {}): ExternalActionSource {
	return {
		kind: "example.file.presence",
		label: "Example file",
		description: "Wait for the example file",
		config: { path: "/tmp/example" },
		...overrides,
	};
}

function createLlmTestConfig() {
	const config = getDefaultConfig();
	config.pi.model_profiles = [
		{ id: "fixture-profile", provider: "fixture-provider", model_id: "fixture-model" },
	];
	return config;
}

const prepareSuccessfulLlmTurnStarts = createSuccessfulLlmTurnStarts();

function createHarness(options: { fileDoneSource?: ExternalActionSource } = {}) {
	const processDef = flow
		.process<Record<string, never>, Record<string, unknown>>("external_source_process")
		.displayName("External Source Process")
		.entry("review")
		.codecs({
			params: { parse: () => ({}), serialize: (value) => value },
			state: stateCodec,
		})
		.initialState(() => ({
			...createEmptyStructuralProcessState(),
			reviewSubject: { kind: "plan" },
		}))
		.turn(
			flow
				.human<Record<string, never>, Record<string, unknown>>("review")
				.description("Review")
				.review("plan")
				.action("accept", (action) => action.label("Accept").acceptanceState("accepted").complete())
				.externalAction("file_done", options.fileDoneSource ?? source(), (external) =>
					external.label("File done").description("Complete from file").complete(),
				)
				.externalAction(
					"file_instruction",
					source({ kind: "example.file.instruction", inputMode: "instruction" }),
					(external) =>
						external
							.label("File instruction")
							.description("Revise from file")
							.publishInput("message", { inputField: "instruction" })
							.to("draft"),
				),
		)
		.turn(
			flow
				.llm<Record<string, never>, Record<string, unknown>>("draft")
				.description("Draft")
				.optionalConsume("message")
				.tools()
				.buildPrompt((ctx) => ctx.input.message ?? "draft")
				.end("drafted")
				.to("review"),
		)
		.define();
	const deps = createTestDeps();
	const processGraphs = createProcessGraphRegistry([processDef]);
	const processActionRegistry = buildProcessActionRegistry({
		processes: new Map([[processDef.id, processDef]]),
	});
	const supervisor = createFakeWorkerSupervisor();
	const engineDeps = {
		...deps,
		config: createLlmTestConfig(),
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => supervisor,
		processGraphs,
		getProcessActionRegistry: () => processActionRegistry,
		prepareTurnStarts: prepareSuccessfulLlmTurnStarts,
	};
	const commands = { run: createEngineRunner(engineDeps) } as unknown as ProcessEngine;
	const service = createExternalSourceService({
		...deps,
		commands,
		processActionRegistry,
	});
	return { deps, processActionRegistry, processGraphs, service };
}

function createWaitingProcess(deps: ReturnType<typeof createTestDeps>) {
	return deps.processes.create({
		processId: "external_source_process",
		selectedTurnId: "review",
		lifecycleStatus: "waiting",
		paramsJson: "{}",
		stateJson: JSON.stringify({
			...createEmptyStructuralProcessState(),
			reviewSubject: { kind: "plan" },
		}),
	});
}

describe("ExternalSourceService", () => {
	it("lists selected-turn external action armings and completes them", async () => {
		const { deps, service } = createHarness();
		const process = createWaitingProcess(deps);

		await service.reconcileAllArmings();
		const armed = service.listArmed("example.file.presence");

		expect(armed).toEqual([
			expect.objectContaining({
				id: "review:file_done",
				instanceId: process.id,
				turnId: "review",
				externalActionId: "file_done",
				source: expect.objectContaining({ kind: "example.file.presence" }),
			}),
		]);
		expect(deps.events.listByInstance(process.id, 10)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "external_source_armed",
					data: expect.objectContaining({
						armingId: "review:file_done",
						externalActionId: "file_done",
						sourceKind: "example.file.presence",
					}),
				}),
			]),
		);

		const result = await service.fire({
			instanceId: process.id,
			armingId: "review:file_done",
			event: { path: "/tmp/example", pollInterval: "1s" },
		});

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: null,
			lifecycleStatus: "completed",
		});
		expect(deps.turnRecords.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				turnId: "review",
				turnType: "external",
				status: "succeeded",
			}),
		]);
		expect(deps.turnAnnotations.listByInstance(process.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					annotationType: "external_trigger",
					payload: expect.objectContaining({
						externalActionId: "file_done",
						sourceKind: "example.file.presence",
					}),
				}),
			]),
		);
		expect(deps.events.listByInstance(process.id, 20)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "external_source_consumed",
					data: expect.objectContaining({ path: "/tmp/example", pollInterval: "1s" }),
				}),
			]),
		);
	});

	it("requires instance identity when two processes expose the same arming id", async () => {
		const { deps, service } = createHarness();
		const processA = createWaitingProcess(deps);
		const processB = createWaitingProcess(deps);

		const duplicateArmings = service.listArmed("example.file.presence").map((arming) => arming.id);
		expect(duplicateArmings).toHaveLength(2);
		expect(new Set(duplicateArmings)).toEqual(new Set(["review:file_done"]));

		const result = await service.fire({
			instanceId: processB.id,
			armingId: "review:file_done",
			event: { path: "/tmp/b" },
		});

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(processA.id)).toMatchObject({
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
		});
		expect(deps.processes.getById(processB.id)).toMatchObject({
			selectedTurnId: null,
			lifecycleStatus: "completed",
		});
	});

	it("serves repeated provider reads from reconciled armings without rescanning processes", async () => {
		const { deps, service } = createHarness();
		const processA = createWaitingProcess(deps);
		createWaitingProcess(deps);
		const listAll = vi.spyOn(deps.processes, "listAll");
		const getById = vi.spyOn(deps.processes, "getById");

		await service.reconcileAllArmings();
		listAll.mockClear();
		getById.mockClear();

		expect(service.listArmed("example.file.presence")).toHaveLength(2);
		expect(service.listArmed("example.file.instruction")).toHaveLength(2);
		expect(listAll).not.toHaveBeenCalled();
		expect(getById).not.toHaveBeenCalled();

		service.invalidateArmings(processA.id);
		expect(service.listArmed("example.file.presence")).toHaveLength(2);
		expect(getById).toHaveBeenCalledTimes(1);
		expect(getById).toHaveBeenCalledWith(processA.id);
		expect(listAll).not.toHaveBeenCalled();
	});

	it("instance-scoped arming reconciliation does not duplicate other processes' armed events", async () => {
		const { deps, service } = createHarness();
		const processA = createWaitingProcess(deps);
		const processB = createWaitingProcess(deps);

		await service.reconcileAllArmings();
		await service.reconcileArmings(processA.id);
		await service.reconcileAllArmings();

		const processBArmedEvents = deps.events
			.listByInstance(processB.id, 20)
			.filter((event) => event.eventType === "external_source_armed");
		expect(processBArmedEvents).toHaveLength(2);
		expect(
			processBArmedEvents.filter((event) => event.data.armingId === "review:file_done"),
		).toHaveLength(1);
	});

	it("maps after-success arming reconciliation failures to post-commit failures", async () => {
		const resolverError = new Error("resolver exploded with secret details");
		const { deps, processActionRegistry, processGraphs } = createHarness({
			fileDoneSource: source({
				resolve() {
					throw resolverError;
				},
			}),
		});
		const process = createWaitingProcess(deps);
		let run: ReturnType<typeof createEngineRunner>;
		const service = createExternalSourceService({
			...deps,
			commands: {
				run: ((operation: never, input: never) => run(operation, input)) as ProcessEngine["run"],
			} as ProcessEngine,
			processActionRegistry,
		});
		run = createEngineRunner(
			{
				...deps,
				processOperations: createProcessOperationCoordinator(),
				getSupervisor: () => undefined,
				processGraphs,
			},
			{
				afterSuccess: async (instanceId) => {
					await service.reconcileArmings(instanceId);
				},
			},
		);
		const MarkCommitted = defineOperation<"mark_committed", { instanceId: string }, void>({
			kind: "mark_committed",
			decide(ctx) {
				return accept({
					writes: {
						events: [
							{
								instanceId: ctx.instanceId,
								eventType: "marker_committed",
								data: { committed: true },
							},
						],
					},
				});
			},
		});

		const result = await run(MarkCommitted, { instanceId: process.id });

		expect(result).toMatchObject({
			ok: false,
			code: "post_commit_failed",
			stage: "post_commit",
			process: { id: process.id },
		});
		if (result.ok) return;
		expect(result.message).toBe("Process operation failed after commit");
		expect(result.message).not.toContain("secret details");
		expect(deps.events.listByInstance(process.id, 10)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					eventType: "marker_committed",
					data: { committed: true },
				}),
			]),
		);
		expect(
			deps.events
				.listByInstance(process.id, 10)
				.filter((event) => event.eventType === "external_source_armed"),
		).toEqual([]);
	});

	it("does not write armed events when the engine arming operation fails", async () => {
		const { deps, processActionRegistry } = createHarness();
		const process = createWaitingProcess(deps);
		const service = createExternalSourceService({
			...deps,
			commands: {
				async run() {
					return {
						ok: false,
						code: "record_failed",
						message: "record failed",
						stage: "pre_commit",
					} as const;
				},
			} as unknown as ProcessEngine,
			processActionRegistry,
		});

		await expect(service.reconcileAllArmings()).rejects.toThrow("record failed");
		expect(deps.events.listByInstance(process.id, 10)).toEqual([]);
	});

	it("does not implicitly queue instruction-mode process input", async () => {
		const { deps, service } = createHarness();
		const process = createWaitingProcess(deps);

		const result = await service.fire({
			instanceId: process.id,
			armingId: "review:file_instruction",
			input: { instruction: "Please revise this file." },
			event: { path: "/tmp/example-instruction" },
		});

		if (!result.ok) {
			throw new Error(JSON.stringify(result));
		}
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "draft",
			lifecycleStatus: "active",
		});
		expect(deps.inputs.listByInstance(process.id)).toEqual([]);
		const [externalTurnRecord] = deps.turnRecords.listByInstance(process.id);
		expect(externalTurnRecord).toMatchObject({
			turnId: "review",
			turnType: "external",
			turnResultMarkdown: "Please revise this file.",
		});
		expect(JSON.parse(deps.processes.getById(process.id)?.stateJson ?? "{}")).toMatchObject({
			productRefs: {
				message: { turnRecordId: externalTurnRecord?.id },
			},
		});
	});

	it("coalesces queued fires by merge key before draining", async () => {
		const { deps, service } = createHarness();
		const process = createWaitingProcess(deps);

		const first = await service.fire({
			instanceId: process.id,
			armingId: "review:file_instruction",
			input: { instruction: "First" },
			event: { path: "/tmp/first" },
		});
		expect(first.ok).toBe(true);

		const second = await service.fire({
			instanceId: process.id,
			armingId: "review:file_instruction",
			input: { instruction: "Second" },
			event: { path: "/tmp/second" },
			mergeKey: "review-file",
		});
		expect(second.ok).toBe(true);
		const third = await service.fire({
			instanceId: process.id,
			armingId: "review:file_instruction",
			input: { instruction: "Third" },
			event: { path: "/tmp/third" },
			mergeKey: "review-file",
		});
		expect(third.ok).toBe(true);

		const [pending] = deps.pendingExternalSourceFires.listByInstance(process.id);
		expect(pending).toMatchObject({
			armingId: "review:file_instruction",
			mergeKey: "review-file",
			queuedCount: 2,
			input: { instruction: "Second\n\nThird" },
		});
		expect(pending?.input.providerInputs).toEqual([
			{ instruction: "Second" },
			{ instruction: "Third" },
		]);
		expect(pending?.event.providerEvents).toEqual([
			{ path: "/tmp/second" },
			{ path: "/tmp/third" },
		]);

		deps.processes.update(process.id, {
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
				reviewSubject: { kind: "plan" },
			}),
		});
		await service.drainQueued(process.id);

		expect(deps.pendingExternalSourceFires.listByInstance(process.id)).toHaveLength(0);
		expect(deps.turnRecords.listByInstance(process.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ turnResultMarkdown: "First" }),
				expect.objectContaining({ turnResultMarkdown: "Second\n\nThird" }),
			]),
		);
	});

	it("queues a competing fire and drains it when the same action is exposed again", async () => {
		const { deps, service } = createHarness();
		const process = createWaitingProcess(deps);

		const first = await service.fire({
			instanceId: process.id,
			armingId: "review:file_instruction",
			input: { instruction: "First" },
			event: { path: "/tmp/first" },
		});
		expect(first.ok).toBe(true);

		const second = await service.fire({
			instanceId: process.id,
			armingId: "review:file_instruction",
			input: { instruction: "Second" },
			event: { path: "/tmp/second" },
		});
		expect(second.ok).toBe(true);
		expect(second.data).toMatchObject({ queued: true });
		expect(deps.pendingExternalSourceFires.listByInstance(process.id)).toHaveLength(1);

		deps.processes.update(process.id, {
			selectedTurnId: "review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
				reviewSubject: { kind: "plan" },
			}),
		});
		await service.drainQueued(process.id);

		expect(deps.pendingExternalSourceFires.listByInstance(process.id)).toHaveLength(0);
		expect(deps.turnRecords.listByInstance(process.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ turnResultMarkdown: "First" }),
				expect.objectContaining({ turnResultMarkdown: "Second" }),
			]),
		);
	});
});
