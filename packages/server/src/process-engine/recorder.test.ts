import type { ProcessInput, ProcessInstance } from "@leitwerk-dev/domain";
import { describe, expect, it, vi } from "vitest";
import type { RecordCommit } from "../process-engine/writes/commit-writes.js";
import { createWrites, type Writes } from "../process-engine/writes/writes.js";
import type {
	ProcessModelPolicyEvaluationSubject,
	ServerProcessModelPolicy,
} from "../process-model-policy/index.js";
import { createProcessOperationCoordinator } from "../process-operation-coordinator.js";
import { createDefaultTestProcessGraphRegistry } from "../test-helpers/process-fixtures.js";
import {
	createTestModelPolicy,
	createTestTurnStart,
} from "../test-helpers/process-model-fixtures.js";
import { createTestDeps } from "../test-helpers/unit-deps.js";
import { accept } from "./decision.js";
import { defineOperation } from "./operation.js";
import { record } from "./recorder.js";
import type { ProcessEngineDeps, RecordResult } from "./types.js";

type ProcessTurnEvaluationSubject = Extract<
	ProcessModelPolicyEvaluationSubject,
	{ kind: "process_turn" }
>;

function createModelPolicyStub(
	resolveProcessTurn: (
		request: ProcessTurnEvaluationSubject,
	) => ReturnType<ServerProcessModelPolicy["evaluate"]> = () => ({
		ok: true,
		selection: null,
		availabilityRevision: 1,
	}),
): ServerProcessModelPolicy {
	const policy = createTestModelPolicy().policy;
	return {
		...policy,
		evaluate: (request) =>
			request.kind === "process_turn" ? resolveProcessTurn(request) : policy.evaluate(request),
	};
}

function createDeps(overrides: Partial<ProcessEngineDeps> = {}): ProcessEngineDeps {
	const deps = createTestDeps();
	return {
		...deps,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => undefined,
		processGraphs: createDefaultTestProcessGraphRegistry(),
		processModelPolicy: createModelPolicyStub(),
		getModelAvailabilitySnapshot: () => ({
			revision: 1,
			capturedAt: "2026-01-01T00:00:00.000Z",
			availabilityTransitions: [],
			profiles: [],
		}),
		...overrides,
	};
}

function createTestLogger() {
	return { error: vi.fn() };
}

const RecordOnly = defineOperation<"record_only", { instanceId: string }, void>({
	kind: "record_only",
	decide() {
		throw new Error("not used");
	},
});

const QueueOnly = defineOperation<"queue_only", { instanceId: string }, ProcessInput[]>({
	kind: "queue_only",
	decide() {
		throw new Error("not used");
	},
});

function recordAccepted(
	deps: ProcessEngineDeps,
	process: ProcessInstance,
	writes: Partial<Writes>,
): Promise<RecordResult<typeof RecordOnly>>;
function recordAccepted(
	deps: ProcessEngineDeps,
	process: ProcessInstance,
	writes: Partial<Writes>,
	options: {
		operation: typeof QueueOnly;
		deriveData?: (commit: RecordCommit) => ProcessInput[];
	},
): Promise<RecordResult<typeof QueueOnly>>;
function recordAccepted(
	deps: ProcessEngineDeps,
	process: ProcessInstance,
	writes: Partial<Writes>,
	options?: {
		operation: typeof QueueOnly;
		deriveData?: (commit: RecordCommit) => ProcessInput[];
	},
): Promise<RecordResult<typeof RecordOnly> | RecordResult<typeof QueueOnly>> {
	if (options) {
		return record(
			deps,
			options.operation,
			{ instanceId: process.id },
			process,
			accept({ writes, data: [], deriveData: options.deriveData }),
		);
	}
	return record(deps, RecordOnly, { instanceId: process.id }, process, accept({ writes }));
}

describe("ProcessEngine recorder", () => {
	it("commits process writes, turn records, annotations, events, inputs, and future executions", async () => {
		const deps = createDeps();
		const process = deps.processes.create({ processId: "jira_issue_process" });
		const future = deps.futureExecutions.create({
			id: "fut_delete_me",
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve",
			payloadJson: "{}",
			nextRunAt: "2099-01-01T00:00:00.000Z",
		});
		const writes = createWrites({
			processPatch: {
				lifecycleStatus: "active",
				selectedTurnId: "generate_plan",
				currentExecution: { kind: "server_turn", id: "trn_recorded" },
			},
			changedFields: ["lifecycleStatus", "selectedTurnId", "currentExecution"],
			turnRecordWrites: [
				{
					kind: "create",
					input: {
						id: "trn_recorded",
						instanceId: process.id,
						turnId: "generate_plan",
						turnType: "server_automatic",
						status: "running",
					},
				},
			],
			turnAnnotationWrites: [
				{
					kind: "create",
					input: {
						id: "tan_recorded",
						instanceId: process.id,
						annotationType: "test_annotation",
						annotationKey: "test:annotation",
						payload: { ok: true },
					},
				},
			],
			events: [{ instanceId: process.id, eventType: "test.event", data: { ok: true } }],
			queuedInputs: [
				{ source: "app_steer", kind: "instruction", bodyMarkdown: "Queued instruction" },
			],
			futureExecutionPlans: [
				{
					kind: "consume",
					futureExecutionId: future.id,
					expectedKind: future.kind,
					expectedNextRunAt: future.nextRunAt,
				},
			],
		});

		const result = await recordAccepted(deps, process, writes);

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			lifecycleStatus: "active",
			selectedTurnId: "generate_plan",
		});
		expect(deps.turnRecords.getById("trn_recorded")).toMatchObject({
			turnId: "generate_plan",
			status: "running",
		});
		expect(deps.turnAnnotations.getById("tan_recorded")).toMatchObject({
			annotationType: "test_annotation",
		});
		expect(deps.events.listByInstance(process.id).map((event) => event.eventType)).toContain(
			"test.event",
		);
		expect(deps.inputs.listByInstance(process.id)).toHaveLength(1);
		expect(deps.futureExecutions.getById(future.id)).toBeNull();
	});

	it("rolls process writes back when a future-execution transition is stale", async () => {
		const deps = createDeps();
		const process = deps.processes.create({ processId: "jira_issue_process" });
		const future = deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve",
			payloadJson: "{}",
			nextRunAt: "2099-01-01T00:00:00.000Z",
		});
		const expectedNextRunAt = future.nextRunAt;
		deps.futureExecutions.update(future.id, { nextRunAt: "2099-01-02T00:00:00.000Z" });

		const result = await recordAccepted(deps, process, {
			processPatch: { lifecycleStatus: "active" },
			changedFields: ["lifecycleStatus"],
			futureExecutionPlans: [
				{
					kind: "consume",
					futureExecutionId: future.id,
					expectedKind: future.kind,
					expectedNextRunAt,
				},
			],
		});

		expect(result.ok).toBe(false);
		expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("discovered");
		expect(deps.futureExecutions.getById(future.id)?.nextRunAt).toBe("2099-01-02T00:00:00.000Z");
	});

	it("derives a complete reaction list including worker reconcile when selected turn changes", async () => {
		const deps = createDeps();
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: null,
			lifecycleStatus: "discovered",
		});
		const writes = createWrites({
			processPatch: { selectedTurnId: "generate_plan", lifecycleStatus: "active" },
			changedFields: ["selectedTurnId", "lifecycleStatus"],
			queuedInputs: [{ source: "system", kind: "instruction", bodyMarkdown: "startup input" }],
			workerIntent: { kind: "reconcile" },
		});

		const result = await recordAccepted(deps, process, writes);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const kinds = result.recorded.reactions.map((reaction) => reaction.kind);
		expect(kinds).toContain("worker_reconcile");
		expect(kinds.indexOf("worker_reconcile")).toBeLessThan(kinds.indexOf("dispatch_inputs"));
	});

	it("derives operation data from the durable record commit", async () => {
		const deps = createDeps();
		const process = deps.processes.create({ processId: "jira_issue_process" });

		const result = await recordAccepted(
			deps,
			process,
			{
				queuedInputs: [
					{ source: "app_steer", kind: "instruction", bodyMarkdown: "First" },
					{ source: "system", kind: "instruction", bodyMarkdown: "Second" },
				],
			},
			{ operation: QueueOnly, deriveData: (commit) => commit.persistedInputs },
		);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.recorded.data.map((input) => input.sequence)).toEqual([1, 2]);
		expect(result.recorded.data.map((input) => input.bodyMarkdown)).toEqual(["First", "Second"]);
	});

	it("parks an invalid LLM model configuration without launching a worker", async () => {
		const deps = createDeps({
			processModelPolicy: createModelPolicyStub(() => ({
				ok: false,
				code: "invalid_model_configuration",
				source: "configuration",
				selection: null,
				issues: [],
			})),
		});
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const writes = createWrites({
			turnStartWrites: [
				{
					kind: "create",
					input: createTestTurnStart({
						id: "tsr_invalid_model",
						instanceId: process.id,
						turnId: "generate_plan",
						proposedTurnRecordId: "trn_invalid_model",
						state: {
							kind: "preparation_failed",
							requestedModelProfileId: null,
							providerOptions: {},
							code: "model_required",
							safeSummary: "LLM start requires model preflight",
						},
					}),
				},
			],
		});

		const result = await recordAccepted(deps, process, writes);

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({ lifecycleStatus: "error" });
		expect(deps.turnStarts.getById("tsr_invalid_model")).toMatchObject({
			state: {
				kind: "preparation_failed",
				code: "invalid_model_configuration",
				safeSummary: "Persisted model configuration is invalid",
			},
		});
	});

	it("rejects a second model availability revision change before commit", async () => {
		const snapshots = [1, 2, 3].map((revision) => ({
			revision,
			capturedAt: "2026-01-01T00:00:00.000Z",
			availabilityTransitions: [],
			profiles: [],
		}));
		let snapshotIndex = 0;
		const deps = createDeps({
			getModelAvailabilitySnapshot: () =>
				snapshots[Math.min(snapshotIndex++, snapshots.length - 1)] as (typeof snapshots)[number],
		});
		const process = deps.processes.create({ processId: "jira_issue_process" });
		const writes = createWrites({
			processPatch: { lifecycleStatus: "active" },
			changedFields: ["lifecycleStatus"],
		});

		const result = await recordAccepted(deps, process, writes);

		expect(result).toMatchObject({
			ok: false,
			stage: "pre_commit",
			code: "stale_evaluation_snapshot",
		});
		expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("discovered");
	});

	it("preserves persisted launch provenance for the first selected turn", async () => {
		const resolveProcessTurn = vi.fn(() => ({
			ok: true as const,
			selection: {
				modelProfileId: "explicit-profile",
				provenance: { kind: "explicit" as const, source: "launch_override" as const },
			},
			availabilityRevision: 1,
		}));
		const deps = createDeps({ processModelPolicy: createModelPolicyStub(resolveProcessTurn) });
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnModelProfileId: "explicit-profile",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "launch_override",
		});
		const writes = createWrites({
			processPatch: { selectedTurnId: "generate_plan", lifecycleStatus: "active" },
			changedFields: ["selectedTurnId", "lifecycleStatus"],
			turnStartWrites: [
				{
					kind: "create",
					input: createTestTurnStart({
						id: "tsr_launch",
						instanceId: process.id,
						turnId: "generate_plan",
						proposedTurnRecordId: "trn_launch",
						startKind: "selected_turn",
					}),
				},
			],
		});

		const result = await recordAccepted(deps, process, writes);

		expect(result.ok).toBe(true);
		expect(resolveProcessTurn).toHaveBeenCalledWith(
			expect.objectContaining({ initialSelection: true, startKind: "selected_turn" }),
		);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnModelProfileId: "explicit-profile",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "launch_override",
		});
	});

	it("preserves explicit selection provenance for startup retry preparation", async () => {
		const resolveProcessTurn = vi.fn(() => ({
			ok: true as const,
			selection: {
				modelProfileId: "explicit-profile",
				provenance: { kind: "explicit" as const, source: "instance_default" as const },
			},
			availabilityRevision: 2,
		}));
		const deps = createDeps({
			processModelPolicy: createModelPolicyStub(resolveProcessTurn),
			getModelAvailabilitySnapshot: () => ({
				revision: 2,
				capturedAt: "2026-01-01T00:00:00.000Z",
				availabilityTransitions: [],
				profiles: [],
			}),
		});
		const process = deps.processes.create({
			processId: "jira_issue_process",
			selectedTurnId: "generate_plan",
			selectedTurnModelProfileId: "explicit-profile",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "instance_default",
			lifecycleStatus: "error",
		});
		const writes = createWrites({
			turnStartWrites: [
				{
					kind: "create",
					input: createTestTurnStart({
						id: "tsr_retry",
						instanceId: process.id,
						turnId: "generate_plan",
						proposedTurnRecordId: "trn_retry",
						startKind: "startup_retry",
						state: {
							kind: "preparation_failed",
							requestedModelProfileId: "explicit-profile",
							providerOptions: {},
							code: "model_unavailable",
							safeSummary: "Unavailable",
						},
					}),
				},
			],
		});

		const result = await recordAccepted(deps, process, writes);

		expect(result.ok).toBe(true);
		expect(resolveProcessTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				startKind: "startup_retry",
				availability: expect.objectContaining({ revision: 2 }),
			}),
		);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnModelProfileId: "explicit-profile",
			selectedTurnModelKind: "explicit",
			selectedTurnModelSource: "instance_default",
		});
	});

	it("reports post-commit failure when finalizing a committed record fails", async () => {
		const logger = createTestLogger();
		const deps = createDeps({ logger });
		const process = deps.processes.create({ processId: "jira_issue_process" });
		const finalizationError = new Error(
			"could not shape committed data at /repo/internal/shape.ts",
		);
		const writes = createWrites({
			processPatch: { lifecycleStatus: "active" },
			changedFields: ["lifecycleStatus"],
		});

		const result = await recordAccepted(deps, process, writes, {
			operation: QueueOnly,
			deriveData() {
				throw finalizationError;
			},
		});

		expect(result).toMatchObject({
			ok: false,
			stage: "post_commit",
			code: "post_commit_failed",
		});
		if (!result.ok) {
			expect(result.message).toBe("Process operation failed after commit");
			expect(result.message).not.toContain("could not shape committed data");
			expect(result.message).not.toContain("/repo/internal/shape.ts");
			expect(logger.error).toHaveBeenCalledWith(
				expect.objectContaining({
					err: finalizationError,
					operationKind: "queue_only",
					instanceId: process.id,
					stage: "post_commit",
					code: "post_commit_failed",
				}),
				"ProcessEngine operation failed",
			);
		}
		expect(deps.processes.getById(process.id)?.lifecycleStatus).toBe("active");
		if (!result.ok && result.stage === "post_commit") {
			expect(result.recorded.process.lifecycleStatus).toBe("active");
		}
	});
});
