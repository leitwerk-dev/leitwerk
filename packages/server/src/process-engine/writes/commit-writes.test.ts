import { createEmptyStructuralProcessState } from "@leitwerk-dev/process-sdk";
import { WS_PRIMARY_PATH_TYPES } from "@leitwerk-dev/protocol";
import { describe, expect, it } from "vitest";
import { createTestDeps } from "../../test-helpers/unit-deps.js";
import { commitWrites, deriveReactions } from "./commit-writes.js";
import { createWrites, type Writes } from "./writes.js";

function recordWrites(
	deps: ReturnType<typeof createTestDeps>,
	instanceId: string,
	writes: Writes,
	options: Parameters<typeof deriveReactions>[2] = {},
) {
	const commit = commitWrites(
		{
			processes: deps.processes,
			events: deps.events,
			inputs: deps.inputs,
			leafOutcomeSnapshots: deps.leafOutcomeSnapshots,
			turnRecords: deps.turnRecords,
			turnStarts: deps.turnStarts,
			turnAnnotations: deps.turnAnnotations,
			futureExecutions: deps.futureExecutions,
			questionRequests: deps.questionRequests,
			transaction: deps.transaction,
		},
		instanceId,
		writes,
	);
	return {
		extensionEvents: commit.extensionEvents,
		workerIntent: commit.workerIntent,
		effects: deriveReactions(commit, writes, options),
	};
}

describe("record writes", () => {
	it("cancels open questions when their turn becomes terminal", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		deps.turnRecords.create({
			id: "trn_questions",
			instanceId: process.id,
			turnId: "generate_plan",
			status: "running",
			pathType: "primary",
		});
		const request = deps.questionRequests.createIdempotent({
			instanceId: process.id,
			turnRecordId: "trn_questions",
			toolCallId: "tool_questions",
			questions: [],
		}).request;

		recordWrites(
			deps,
			process.id,
			createWrites({
				turnRecordWrites: [
					{
						kind: "update",
						id: "trn_questions",
						input: { status: "failed", endedAt: "2026-07-26T00:00:00.000Z" },
					},
				],
			}),
		);

		expect(deps.questionRequests.getById(request.id)).toMatchObject({
			status: "cancelled",
			cancelledAt: expect.any(String),
		});
	});

	it("applies patch, events, broadcasts, and queued inputs exactly once", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		deps.turnRecords.create({
			id: "trn_existing",
			instanceId: process.id,
			turnId: "generate_plan",
			status: "running",
			pathType: "primary",
		});

		const plan = createWrites({
			processPatch: {
				selectedTurnId: "plan_review",
				lifecycleStatus: "waiting",
			},
			changedFields: ["selectedTurnId", "lifecycleStatus"],
			turnRecordWrites: [
				{
					kind: "update",
					id: "trn_existing",
					input: {
						status: "succeeded",
						endedAt: "2026-04-09T00:00:00.000Z",
					},
				},
				{
					kind: "create",
					input: {
						id: "trn_followup",
						instanceId: process.id,
						turnId: "generate_plan",
						turnType: "human",
						status: "succeeded",
						pathType: "primary",
						endedAt: "2026-04-09T00:00:01.000Z",
					},
				},
			],
			turnAnnotationWrites: [
				{
					kind: "create",
					input: {
						id: "tan_plan",
						instanceId: process.id,
						annotationType: "turn_milestone",
						annotationKey: "turn_milestone:trn_existing",
						references: [{ kind: "turn_record", turnRecordId: "trn_existing", role: "subject" }],
						payload: { turnId: "generate_plan" },
					},
				},
			],
			leafOutcomeSnapshotWrites: [
				{
					kind: "create",
					input: {
						instanceId: process.id,
						leafEntryId: "assistant-plan",
						turnRecordId: "trn_existing",
						rendererId: "test:plan.leaf_outcome",
						props: { title: "Plan" },
						fallbackMarkdown: "## Plan",
						status: "ready",
						anchoredAt: "2026-04-09T00:00:00.000Z",
					},
				},
			],
			events: [
				{
					instanceId: process.id,
					eventType: "turn_selected",
					data: { fromTurnId: "generate_plan", toTurnId: "plan_review" },
				},
			],
			broadcasts: [
				{
					type: "process.event",
					payload: {
						eventType: "turn_selected",
						level: "info",
						message: "Selected turn plan_review",
					},
					instanceId: process.id,
				},
			],
			queuedInputs: [{ source: "app_steer", kind: "instruction", bodyMarkdown: "Please revise" }],
			extensionEvents: [
				{
					type: "plan_approved",
					payload: { instanceId: process.id, externalId: null, planRevision: 1 },
				},
			],
			workerIntent: { kind: "reconcile" },
		});

		const applied = recordWrites(deps, process.id, plan);

		const broadcasts = applied.effects
			.filter((effect) => effect.kind === "broadcast")
			.map((effect) => effect.frame);

		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
		});
		expect(deps.turnRecords.getById("trn_existing")).toMatchObject({
			status: "succeeded",
			endedAt: "2026-04-09T00:00:00.000Z",
		});
		expect(deps.turnRecords.getById("trn_followup")).toMatchObject({
			status: "succeeded",
			endedAt: "2026-04-09T00:00:01.000Z",
		});
		expect(deps.turnAnnotations.getById("tan_plan")).toMatchObject({
			annotationType: "turn_milestone",
			annotationKey: "turn_milestone:trn_existing",
		});
		const events = deps.events.listByInstance(process.id, 10);
		expect(events.filter((event) => event.eventType !== "turn.lifecycle")).toHaveLength(1);
		expect(
			events.filter((event) => event.eventType === "turn.lifecycle").map((event) => event.data),
		).toEqual([
			{ turnRecordId: "trn_followup", status: "succeeded" },
			{ turnRecordId: "trn_existing", status: "succeeded" },
		]);
		expect(deps.leafOutcomeSnapshots.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				leafEntryId: "assistant-plan",
				turnRecordId: "trn_existing",
				status: "ready",
			}),
		]);
		expect(deps.inputs.listByInstance(process.id)).toHaveLength(1);
		expect(broadcasts.map((entry) => entry.type)).toEqual(
			expect.arrayContaining(["process.event", "process.updated", "process.input.queued"]),
		);
		expect(applied.extensionEvents).toEqual(plan.extensionEvents);
		expect(applied.workerIntent).toEqual({ kind: "reconcile" });
	});

	it("includes the committed process updatedAt in process.updated patches", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});

		const applied = recordWrites(
			deps,
			process.id,
			createWrites({
				processPatch: {
					selectedTurnId: "plan_review",
					lifecycleStatus: "waiting",
				},
				changedFields: ["selectedTurnId", "lifecycleStatus"],
			}),
		);
		const updated = deps.processes.getById(process.id);
		const processUpdatedFrame = applied.effects
			.filter((effect) => effect.kind === "broadcast")
			.map((effect) => effect.frame)
			.find((frame) => frame.type === "process.updated");

		expect(processUpdatedFrame).toMatchObject({
			type: "process.updated",
			payload: {
				process: {
					selectedTurnId: "plan_review",
					lifecycleStatus: "waiting",
					updatedAt: updated?.updatedAt,
				},
				changedFields: ["selectedTurnId", "lifecycleStatus", "updatedAt"],
			},
		});
	});

	it("includes committed timestamps in terminal process.updated patches", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});

		const applied = recordWrites(
			deps,
			process.id,
			createWrites({
				processPatch: { selectedTurnId: null, lifecycleStatus: "completed" },
				changedFields: ["selectedTurnId", "lifecycleStatus"],
			}),
		);
		const updated = deps.processes.getById(process.id);
		const processUpdatedFrame = applied.effects
			.filter((effect) => effect.kind === "broadcast")
			.map((effect) => effect.frame)
			.find((frame) => frame.type === "process.updated");

		expect(updated?.closedAt).toEqual(expect.any(String));
		expect(processUpdatedFrame).toMatchObject({
			type: "process.updated",
			payload: {
				process: {
					selectedTurnId: null,
					lifecycleStatus: "completed",
					updatedAt: updated?.updatedAt,
					closedAt: updated?.closedAt,
				},
				changedFields: ["selectedTurnId", "lifecycleStatus", "updatedAt", "closedAt"],
			},
		});
	});

	it("emits generic extension events for committed process updates, turn starts/failures, and leaf outcomes", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});

		const applied = recordWrites(
			deps,
			process.id,
			createWrites({
				processPatch: { stateJson: "{}" },
				changedFields: ["stateJson"],
				turnRecordWrites: [
					{
						kind: "create",
						input: {
							id: "trn_live_1",
							instanceId: process.id,
							turnId: "implement",
							turnType: "human",
							status: "running",
							pathType: "primary",
							startedAt: "2026-04-14T10:00:00.000Z",
						},
					},
					{
						kind: "create",
						input: {
							id: "trn_failed_1",
							instanceId: process.id,
							turnId: "implement",
							turnType: "human",
							status: "failed",
							pathType: "primary",
							startedAt: "2026-04-14T10:00:00.000Z",
							endedAt: "2026-04-14T10:01:00.000Z",
							errorSummary: "Boom",
						},
					},
				],
				leafOutcomeSnapshotWrites: [
					{
						kind: "create",
						input: {
							instanceId: process.id,
							leafEntryId: "assistant-result",
							turnRecordId: "trn_live_1",
							rendererId: "test:result",
							props: { ok: true },
							fallbackMarkdown: "Result",
							status: "ready",
							anchoredAt: "2026-04-14T10:01:00.000Z",
						},
					},
				],
			}),
		);

		const extensionEvents = applied.effects.filter((effect) => effect.kind === "extension_event");
		const extensionEventTypes = extensionEvents.map((effect) => effect.event.type);
		expect(extensionEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "extension_event",
					event: expect.objectContaining({ type: "process_updated" }),
				}),
				expect.objectContaining({
					kind: "extension_event",
					event: expect.objectContaining({ type: "turn_started" }),
				}),
				expect.objectContaining({
					kind: "extension_event",
					event: expect.objectContaining({ type: "turn_failed" }),
				}),
				expect.objectContaining({
					kind: "extension_event",
					event: expect.objectContaining({ type: "leaf_outcome_captured" }),
				}),
			]),
		);
		expect(extensionEventTypes.indexOf("leaf_outcome_captured")).toBeLessThan(
			extensionEventTypes.indexOf("process_updated"),
		);
	});

	it("emits normalized primary-path turn started frames after the turn record is committed", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});

		const applied = recordWrites(
			deps,
			process.id,
			createWrites({
				processPatch: {
					lifecycleStatus: "active",
				},
				changedFields: ["lifecycleStatus"],
				turnRecordWrites: [
					{
						kind: "create",
						input: {
							id: "trn_live_1",
							instanceId: process.id,
							turnId: "implement",
							turnType: "human",
							status: "running",
							pathType: "primary",
							startedAt: "2026-04-14T10:00:00.000Z",
						},
					},
				],
			}),
		);

		const broadcasts = applied.effects
			.filter((effect) => effect.kind === "broadcast")
			.map((effect) => effect.frame);

		expect(broadcasts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.TURN_STARTED,
					instanceId: process.id,
					payload: expect.objectContaining({
						turnRecord: expect.objectContaining({
							id: "trn_live_1",
							turnId: "implement",
							status: "running",
						}),
					}),
				}),
			]),
		);
	});

	it("emits assistant commit and acceptance-state annotation frames without a redundant primary-path changed frame", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
				semanticEntryRefs: {
					rootEntry: { entryId: "root-user", turnRecordId: null },
					currentPrimaryPathLeaf: { entryId: "assistant-plan", turnRecordId: "trn_plan_1" },
					plan: null,
					review: null,
				},
			}),
		});
		deps.turnRecords.create({
			id: "trn_live_2",
			instanceId: process.id,
			turnId: "implement",
			status: "running",
			pathType: "primary",
			forkPiEntryId: "assistant-plan",
			startedAt: "2026-04-14T10:00:00.000Z",
		});

		const applied = recordWrites(
			deps,
			process.id,
			createWrites({
				processPatch: {
					stateJson: JSON.stringify({
						...createEmptyStructuralProcessState(),
						semanticEntryRefs: {
							rootEntry: { entryId: "root-user", turnRecordId: null },
							currentPrimaryPathLeaf: {
								entryId: "assistant-impl",
								turnRecordId: "trn_live_2",
							},
							plan: null,
							review: null,
						},
					}),
				},
				changedFields: ["stateJson"],
				turnRecordWrites: [
					{
						kind: "update",
						id: "trn_live_2",
						input: {
							status: "succeeded",
							resultPiEntryId: "assistant-impl",
							turnResultMarkdown: "## Implemented",
							endedAt: "2026-04-14T10:05:00.000Z",
						},
					},
				],
				turnAnnotationWrites: [
					{
						kind: "create",
						input: {
							instanceId: process.id,
							annotationType: "acceptance_state",
							annotationKey: "acceptance_state:trn_live_2",
							references: [{ kind: "turn_record", turnRecordId: "trn_live_2", role: "subject" }],
							payload: {
								turnId: "implementation_review",
								acceptanceState: "accepted",
							},
						},
					},
				],
			}),
		);

		const broadcasts = applied.effects
			.filter((effect) => effect.kind === "broadcast")
			.map((effect) => effect.frame);

		expect(broadcasts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED,
					payload: expect.objectContaining({
						turnRecord: expect.objectContaining({
							id: "trn_live_2",
							resultPiEntryId: "assistant-impl",
							turnResultMarkdown: "## Implemented",
						}),
						currentLeaf: {
							entryId: "assistant-impl",
							turnRecordId: "trn_live_2",
						},
					}),
				}),
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED,
					payload: expect.objectContaining({
						change: "created",
						annotation: expect.objectContaining({
							annotationType: "acceptance_state",
							annotationKey: "acceptance_state:trn_live_2",
							payload: expect.objectContaining({ acceptanceState: "accepted" }),
						}),
					}),
				}),
			]),
		);

		expect(broadcasts.some((broadcast) => broadcast.type === WS_PRIMARY_PATH_TYPES.CHANGED)).toBe(
			false,
		);
	});

	it("emits primary-path changed frames when semantic entry refs move without an assistant commit", () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
			stateJson: JSON.stringify(createEmptyStructuralProcessState()),
		});

		const applied = recordWrites(
			deps,
			process.id,
			createWrites({
				processPatch: {
					stateJson: JSON.stringify({
						...createEmptyStructuralProcessState(),
						semanticEntryRefs: {
							rootEntry: { entryId: "root-user", turnRecordId: null },
							currentPrimaryPathLeaf: { entryId: "user-followup", turnRecordId: null },
							plan: null,
							review: null,
						},
					}),
				},
				changedFields: ["stateJson"],
			}),
		);

		const broadcasts = applied.effects
			.filter((effect) => effect.kind === "broadcast")
			.map((effect) => effect.frame);

		expect(broadcasts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.CHANGED,
					payload: {
						rootEntry: { entryId: "root-user", turnRecordId: null },
						currentLeaf: { entryId: "user-followup", turnRecordId: null },
					},
				}),
			]),
		);
	});
});
