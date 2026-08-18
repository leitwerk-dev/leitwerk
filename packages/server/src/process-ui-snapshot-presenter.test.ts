import type {
	ProcessInstance,
	ProcessTurnAnnotation,
	ProcessTurnRecord,
	TurnStartRecord,
} from "@leitwerk-dev/domain";
import { describe, expect, it } from "vitest";
import {
	buildStartupRecovery,
	presentProcessTimelineTurns,
	projectProcessForUiSnapshot,
	resolveCurrentExecutionTurnRecordId,
} from "./process-ui-snapshot-presenter.js";

function processInstance(overrides: Partial<ProcessInstance> = {}): ProcessInstance {
	return {
		id: "agt_presenter",
		processId: "presenter_test_process",
		selectedTurnId: null,
		lifecycleStatus: "completed",
		currentExecution: null,
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: null,
		defaultModelProfileId: null,
		turnConfigsJson: null,
		selectedTurnModelProfileId: null,
		paramsJson: null,
		stateJson: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:02:00.000Z",
		closedAt: "2026-01-01T00:02:00.000Z",
		...overrides,
	};
}

function turnStart(overrides: Partial<TurnStartRecord> = {}): TurnStartRecord {
	return {
		id: "str_presenter",
		instanceId: "agt_presenter",
		turnId: "generate_plan",
		turnType: "llm",
		proposedTurnRecordId: "trn_presenter",
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {} as never,
			turnRecordId: "trn_presenter",
			acceptedWorkerLeaseId: "wkr_1",
		},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function turnRecord(overrides: Partial<ProcessTurnRecord> = {}): ProcessTurnRecord {
	const id = overrides.id ?? "trn_presenter";
	const turnType = overrides.turnType ?? "llm";
	const workerOwned = turnType === "llm" || turnType === "automatic";
	return {
		id,
		instanceId: "agt_presenter",
		turnId: "generate_plan",
		turnType,
		status: "succeeded",
		pathType: "primary",
		attemptNumber: 1,
		parentTurnRecordId: null,
		forkPiEntryId: null,
		turnStartRecordId: workerOwned ? (overrides.turnStartRecordId ?? "str_presenter") : null,
		acceptedWorkerLeaseId: workerOwned ? (overrides.acceptedWorkerLeaseId ?? "wkr_1") : null,
		resultPiEntryId: null,
		modelProfileId: null,
		turnResultMarkdown: null,
		errorClass: null,
		errorSummary: null,
		startedAt: "2026-01-01T00:00:30.000Z",
		endedAt: "2026-01-01T00:01:30.000Z",
		createdAt: "2026-01-01T00:00:30.000Z",
		updatedAt: "2026-01-01T00:01:30.000Z",
		...overrides,
	};
}

describe("process UI snapshot presenter", () => {
	it("resolves the active turn through the current execution reference", () => {
		const acceptedStart = turnStart();
		const starts = { getById: (id: string) => (id === acceptedStart.id ? acceptedStart : null) };
		expect(
			resolveCurrentExecutionTurnRecordId(
				processInstance({ currentExecution: { kind: "server_turn", id: "trn_server" } }),
				starts,
			),
		).toBe("trn_server");
		expect(
			resolveCurrentExecutionTurnRecordId(
				processInstance({ currentExecution: { kind: "worker_start", id: acceptedStart.id } }),
				starts,
			),
		).toBe("trn_presenter");
		expect(
			resolveCurrentExecutionTurnRecordId(
				processInstance({ currentExecution: { kind: "worker_start", id: "str_starting" } }),
				{ getById: () => turnStart({ state: { kind: "starting", start: {} as never } }) },
			),
		).toBeNull();
	});

	it("exposes current execution without deprecated turn pointers", () => {
		const projected = projectProcessForUiSnapshot(
			processInstance({ currentExecution: { kind: "server_turn", id: "trn_server" } }),
		) as Record<string, unknown>;
		expect(projected.currentExecution).toEqual({ kind: "server_turn", id: "trn_server" });
		expect(projected).not.toHaveProperty("currentTurnRecordId");
		expect(projected).not.toHaveProperty("failedTurnRecordId");
	});

	it("offers Continue for legacy terminal outcome recording failures with saved Pi progress", () => {
		const failed = turnRecord({
			status: "failed",
			errorSummary: "Server could not durably record worker turn outcome: invalid transition",
			errorClass: "infrastructure",
		});
		const start = turnStart();
		expect(
			buildCurrentTurnRecovery({
				process: processInstance({
					selectedTurnId: failed.turnId,
					lifecycleStatus: "error",
					currentExecution: { kind: "worker_start", id: start.id },
				}),
				turnStarts: { getById: () => start },
				turnRecords: [failed],
				selectedTurnDescription: "Generate plan",
				piEntries: [
					{
						id: "assistant-plan",
						parentId: null,
						timestamp: "2026-01-01T00:01:00.000Z",
						type: "message",
						message: { role: "assistant", content: [{ type: "text", text: "# Plan" }] },
					} as never,
				],
			}),
		).toMatchObject({
			turnRecordId: failed.id,
			canContinue: true,
			supportsModelOverride: true,
		});
	});

	it("projects actionable startup failures from the current worker start", () => {
		for (const [kind, action] of [
			["preparation_failed", "choose_model"],
			["bootstrap_failed", "retry_startup"],
		] as const) {
			const start = turnStart({ state: { kind, safeSummary: "safe failure" } });
			expect(
				buildStartupRecovery(
					processInstance({
						lifecycleStatus: "error",
						currentExecution: { kind: "worker_start", id: start.id },
					}),
					{ getById: () => start },
				),
			).toMatchObject({ startRecordId: start.id, kind, action, summary: "safe failure" });
		}
	});
	it("projects durable outcomes and preserves compact preview metadata fields", () => {
		const record = turnRecord({ turnResultMarkdown: "## Durable result" });
		const turns = presentProcessTimelineTurns({
			process: processInstance(),
			turnRecords: [record],
			turnAnnotations: [] as ProcessTurnAnnotation[],
			events: [
				{
					id: "evt_progress",
					instanceId: "agt_presenter",
					eventType: "turn.progress",
					data: {
						turnRecordId: record.id,
						report: {
							title: "Delivery progress",
							steps: [{ id: "validate", label: "Validate", status: "completed" }],
							links: [
								{
									id: "pr-12",
									label: "PR #12",
									url: "https://example.test/pr/12",
									kind: "pull_request",
								},
							],
						},
					},
					createdAt: "2026-01-01T00:01:00.000Z",
				},
				{
					id: "evt_outcome",
					instanceId: "agt_presenter",
					eventType: "turn_outcome_recorded",
					data: {
						turnRecordId: record.id,
						turnId: record.turnId,
						outcome: "plan_saved",
						params: { summary: "Plan captured", planMarkdown: "diagnostic duplicate" },
					},
					createdAt: "2026-01-01T00:01:30.000Z",
				},
			],
			activeTurn: null,
			selectedTurnType: null,
		});

		expect(turns).toEqual([
			expect.objectContaining({
				id: record.id,
				outcome: "plan_saved",
				summary: "Plan captured",
				output: "Plan captured",
				turnResultMarkdown: "## Durable result",
				attemptNumber: 1,
				startedAt: record.startedAt,
				endedAt: record.endedAt,
				progress: expect.objectContaining({
					title: "Delivery progress",
					links: [expect.objectContaining({ url: "https://example.test/pr/12" })],
				}),
			}),
		]);
	});

	it("projects and propagates action provenance onto timeline turns", () => {
		const decision = turnRecord({
			id: "trn_decision",
			turnId: "approve_plan",
			turnType: "human",
			startedAt: "2026-01-01T00:01:00.000Z",
			endedAt: "2026-01-01T00:01:00.000Z",
		});
		const implementation = turnRecord({
			id: "trn_implementation",
			turnId: "implement",
			startedAt: "2026-01-01T00:01:01.000Z",
		});
		const turns = presentProcessTimelineTurns({
			process: processInstance(),
			turnRecords: [decision, implementation],
			turnAnnotations: [
				{
					id: "ann_decision",
					instanceId: "agt_presenter",
					annotationType: "acceptance_state",
					annotationKey: "decision",
					payload: {
						actionSource: "scheduled",
						causedSelectedTurnId: "implement",
						causedSelectedTurnType: "llm",
					},
					references: [{ kind: "turn_record", turnRecordId: decision.id }],
					createdAt: "2026-01-01T00:01:00.000Z",
					updatedAt: "2026-01-01T00:01:00.000Z",
				},
			],
			events: [],
			activeTurn: null,
			selectedTurnType: null,
		});

		expect(turns.find((turn) => turn.id === decision.id)?.actionSource).toBe("scheduled");
		expect(turns.find((turn) => turn.id === implementation.id)?.actionSource).toBe("scheduled");
	});

	it("synthesizes the active selected turn with its effective runtime model", () => {
		const turns = presentProcessTimelineTurns({
			process: processInstance({
				lifecycleStatus: "active",
				selectedTurnId: "implement",
				selectedTurnModelProfileId: "removed_historical_model",
				closedAt: null,
			}),
			turnRecords: [],
			turnAnnotations: [],
			events: [],
			activeTurn: null,
			selectedTurnType: "llm",
			activeModelProfileId: "current_runtime_model",
		});

		expect(turns).toEqual([
			expect.objectContaining({
				id: "current:implement",
				turnId: "implement",
				status: "in_progress",
				modelProfileId: "current_runtime_model",
			}),
		]);
	});
});
