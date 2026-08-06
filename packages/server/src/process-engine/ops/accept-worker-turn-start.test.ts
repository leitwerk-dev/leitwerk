import type {
	PreparedTurnStart,
	ProcessInstance,
	TurnStartContinuation,
	TurnStartKind,
} from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import { createProcessOperationCoordinator } from "../../process-operation-coordinator.js";
import {
	createDefaultTestProcessGraphRegistry,
	createFixtureLlmTurn,
	createFixtureProcess,
	createProcessGraphRegistry,
} from "../../test-helpers/process-fixtures.js";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import type { DecideContext, ProcessEngineDeps } from "../types.js";
import { commitWrites } from "../writes/commit-writes.js";
import { AcceptWorkerTurnStart } from "./accept-worker-turn-start.js";

function setup(
	input: {
		processId?: string;
		turnId?: string;
		processGraphs?: ProcessEngineDeps["processGraphs"];
		preparedStart?: PreparedTurnStart | null;
		startKind?: TurnStartKind;
		recoveryTurnRecordId?: string | null;
		continuation?: TurnStartContinuation | null;
		metadata?: ProcessInstance["metadata"];
	} = {},
) {
	const processId = input.processId ?? "jira_issue_process";
	const turnId = input.turnId ?? "generate_plan";
	const base = createTestDeps();
	const deps: ProcessEngineDeps = {
		...base,
		processOperations: createProcessOperationCoordinator(),
		getSupervisor: () => undefined,
		processGraphs: input.processGraphs ?? createDefaultTestProcessGraphRegistry(),
	};
	const process = deps.processes.create({
		processId,
		selectedTurnId: turnId,
		lifecycleStatus: "active",
		metadata: input.metadata,
	});
	if (input.recoveryTurnRecordId) {
		deps.turnRecords.create({
			id: input.recoveryTurnRecordId,
			instanceId: process.id,
			turnId,
			status: "failed",
			attemptNumber: 1,
			pathType: "primary",
			forkPiEntryId: "assistant-failed-1",
		});
	}
	const start = deps.turnStarts.create({
		id: "tsr_1",
		instanceId: process.id,
		turnId,
		turnType: "llm",
		proposedTurnRecordId: "trn_1",
		startKind: input.startKind ?? "selected_turn",
		recoveryTurnRecordId: input.recoveryTurnRecordId ?? null,
		continuation: input.continuation ?? null,
		state: {
			kind: "starting",
			start: {
				kind: "llm",
				model: { profileId: "p", providerId: "openai", modelId: "gpt", thinkingLevel: "low" },
				modelSelectionProvenance: { kind: "explicit", source: "action_override" },
				availabilityRevision: 3,
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "digest",
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
		},
	});
	deps.processes.update(process.id, { currentExecution: { kind: "worker_start", id: start.id } });
	const lease = deps.leases.create({ instanceId: process.id, workerId: "wkr_1", state: "busy" });
	deps.leases.compareAndSetBootstrapReceipt(lease.id, {
		kind: "llm",
		startRecordId: start.id,
		workerLeaseId: lease.id,
		receiptEpoch: "e",
		verifiedResourceSnapshotDigest: "digest",
		credentialRevision: 1,
		loadedResourceIds: [],
		resolvedModel: { providerId: "openai", modelId: "gpt" },
		preparedStart:
			input.preparedStart === undefined
				? {
						pathType: "primary",
						contextMode: "fresh",
						startTarget: { kind: "root" },
						forkPiEntryId: null,
					}
				: input.preparedStart,
		readyAt: "2026-01-01T00:00:00.000Z",
	});
	const context = (): DecideContext => {
		const current = deps.processes.getById(process.id);
		if (!current) throw new Error("Expected fixture process");
		return { deps, instanceId: process.id, process: current };
	};
	return { deps, process, start, lease, context };
}

describe("AcceptWorkerTurnStart", () => {
	it("accepts once, creates one attempt, and preserves the worker-start anchor", () => {
		const s = setup();
		const decision = AcceptWorkerTurnStart.decide(s.context(), {
			instanceId: s.process.id,
			workerLeaseId: s.lease.id,
			startRecordId: s.start.id,
			proposedTurnRecordId: "trn_1",
		});
		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		commitWrites(s.deps, s.process.id, decision.writes);
		expect(s.deps.turnRecords.getById("trn_1")).toMatchObject({
			attemptNumber: 1,
			modelProfileId: "p",
			modelSelectionProvenance: { kind: "explicit", source: "action_override" },
		});
		expect(s.deps.processes.getById(s.process.id)?.currentExecution).toEqual({
			kind: "worker_start",
			id: "tsr_1",
		});
		expect(s.deps.turnStarts.getById("tsr_1")?.state.kind).toBe("accepted");
		const replay = AcceptWorkerTurnStart.decide(s.context(), {
			instanceId: s.process.id,
			workerLeaseId: s.lease.id,
			startRecordId: "tsr_1",
			proposedTurnRecordId: "trn_1",
		});
		expect(replay).toMatchObject({ ok: true, data: { turnRecordId: "trn_1" } });
		if (replay.ok) expect(replay.writes.turnRecordWrites).toEqual([]);
	});

	it("clears failed-turn continuation metadata when Continue is accepted", () => {
		const s = setup({
			startKind: "continue",
			preparedStart: {
				pathType: "primary",
				contextMode: "fresh",
				startTarget: { kind: "entry", entryId: "assistant-failed-1" },
				forkPiEntryId: "assistant-failed-1",
			},
			continuation: {
				continueFromPiEntryId: "assistant-failed-1",
				continuePrompt: "continue",
				savedPrimaryLeafEntryId: "assistant-primary-1",
			},
			metadata: {
				launcherId: "test-launcher",
				continueFromPiEntryId: "assistant-failed-1",
				continueFromTurnRecordId: "trn_failed_1",
				continueSavedPrimaryLeafEntryId: "assistant-primary-1",
				continuePrompt: "continue",
				failedTurnRecovery: {
					turnRecordId: "trn_failed_1",
					strategy: "continue",
					suggestedContinuePrompt: "continue",
					failureCode: "generic_continue",
				},
			},
		});

		const decision = AcceptWorkerTurnStart.decide(s.context(), {
			instanceId: s.process.id,
			workerLeaseId: s.lease.id,
			startRecordId: s.start.id,
			proposedTurnRecordId: "trn_1",
		});

		expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
		if (!decision.ok) return;
		commitWrites(s.deps, s.process.id, decision.writes);
		expect(s.deps.processes.getById(s.process.id)?.metadata).toEqual({
			launcherId: "test-launcher",
		});
	});

	it("records fresh root-branch provenance from the accepting lease receipt", () => {
		const processGraphs = createProcessGraphRegistry([
			createFixtureProcess({
				id: "root_review_process",
				entry: "review",
				turns: {
					review: createFixtureLlmTurn("review", {
						branchType: "root_branch",
						context: "full",
						startFrom: { kind: "session_root" },
					}),
				},
			}),
		]);
		const s = setup({
			processId: "root_review_process",
			turnId: "review",
			processGraphs,
			preparedStart: {
				pathType: "root_branch",
				contextMode: "full",
				startTarget: { kind: "entry", entryId: "root-user" },
				forkPiEntryId: "root-user",
			},
		});

		const decision = AcceptWorkerTurnStart.decide(s.context(), {
			instanceId: s.process.id,
			workerLeaseId: s.lease.id,
			startRecordId: s.start.id,
			proposedTurnRecordId: "trn_1",
		});

		expect(decision.ok).toBe(true);
		if (!decision.ok) return;
		commitWrites(s.deps, s.process.id, decision.writes);
		expect(s.deps.turnRecords.getById("trn_1")).toMatchObject({
			pathType: "root_branch",
			forkPiEntryId: "root-user",
			acceptedWorkerLeaseId: s.lease.id,
		});
	});

	it("rejects missing or malformed LLM prepared starts", () => {
		for (const preparedStart of [
			null,
			{
				pathType: "primary",
				contextMode: "fresh",
				startTarget: { kind: "entry", entryId: "expected" },
				forkPiEntryId: "different",
			} as const,
		]) {
			const s = setup({ preparedStart });
			expect(
				AcceptWorkerTurnStart.decide(s.context(), {
					instanceId: s.process.id,
					workerLeaseId: s.lease.id,
					startRecordId: s.start.id,
					proposedTurnRecordId: "trn_1",
				}),
			).toMatchObject({ ok: false, code: "worker_receipt_invalid" });
		}
	});

	it("rejects stale identities, receipt/lease mismatches, and non-active lifecycle", () => {
		const s = setup();
		expect(
			AcceptWorkerTurnStart.decide(s.context(), {
				instanceId: s.process.id,
				workerLeaseId: s.lease.id,
				startRecordId: "tsr_1",
				proposedTurnRecordId: "wrong",
			}),
		).toMatchObject({ ok: false, code: "stale_turn_start" });
		expect(
			AcceptWorkerTurnStart.decide(s.context(), {
				instanceId: s.process.id,
				workerLeaseId: "other",
				startRecordId: "tsr_1",
				proposedTurnRecordId: "trn_1",
			}),
		).toMatchObject({ ok: false, code: "worker_receipt_invalid" });
		s.deps.processes.update(s.process.id, { lifecycleStatus: "completed", currentExecution: null });
		expect(
			AcceptWorkerTurnStart.decide(s.context(), {
				instanceId: s.process.id,
				workerLeaseId: s.lease.id,
				startRecordId: "tsr_1",
				proposedTurnRecordId: "trn_1",
			}),
		).toMatchObject({ ok: false, code: "stale_turn_start" });
	});

	it("does not let a prior lease receipt authorize a replacement lease", () => {
		const s = setup();
		s.deps.leases.update(s.lease.id, {
			state: "exited",
			exitedAt: "2026-01-01T00:00:01.000Z",
		});
		const replacement = s.deps.leases.create({
			instanceId: s.process.id,
			workerId: "wkr_replacement",
			state: "busy",
		});

		expect(
			AcceptWorkerTurnStart.decide(s.context(), {
				instanceId: s.process.id,
				workerLeaseId: replacement.id,
				startRecordId: s.start.id,
				proposedTurnRecordId: "trn_1",
			}),
		).toMatchObject({ ok: false, code: "worker_receipt_invalid" });
	});
});
