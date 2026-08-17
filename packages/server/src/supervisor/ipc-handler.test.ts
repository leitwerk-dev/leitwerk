import { WS_PRIMARY_PATH_TYPES, type WsFrame } from "@leitwerk-dev/protocol";
import { createTestQuestion } from "@leitwerk-dev/test-support/fixtures";
import { IPC_PROTOCOL_VERSION, type IpcEnvelope } from "@leitwerk-dev/worker-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestIpcHandler } from "../test-helpers/ipc-handler-harness.js";
import { createTestDeps, type TestDeps } from "../test-helpers/unit-deps.js";

let t: TestDeps;

const promptBranchDriftDetails = {
	operation: "prompt",
	anchorEntryId: "user-plan",
	rejectedResultEntryId: "turn-stale",
} as const;

function flushAsyncWork() {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

function setupAcceptedTurn(input: {
	instanceId: string;
	workerId: string;
	turnRecordId: string;
	turnId: string;
}) {
	const lease = t.leases.create({
		instanceId: input.instanceId,
		workerId: input.workerId,
		state: "bootstrapping",
	});
	const startRecordId = `tsr_${input.turnRecordId}`;
	t.leases.compareAndSetBootstrapReceipt(lease.id, {
		kind: "llm",
		startRecordId,
		workerLeaseId: lease.id,
		receiptEpoch: "fixture-epoch",
		verifiedResourceSnapshotDigest: "fixture-resource-snapshot",
		credentialRevision: 1,
		loadedResourceIds: [],
		resolvedModel: { providerId: "fixture-provider", modelId: "fixture-model" },
		preparedStart: {
			pathType: "primary",
			contextMode: "full",
			startTarget: { kind: "current_leaf" },
			forkPiEntryId: null,
		},
		readyAt: "2026-01-01T00:00:00.000Z",
	});
	t.leases.update(lease.id, { state: "busy" });
	const start = t.turnStarts.create({
		id: startRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.turnRecordId,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: {
					profileId: "fixture-model",
					providerId: "fixture-provider",
					modelId: "fixture-model",
					thinkingLevel: "low",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "fixture-resource-snapshot",
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
			turnRecordId: input.turnRecordId,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	t.turnRecords.create({
		id: input.turnRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		status: "running",
		turnStartRecordId: start.id,
		acceptedWorkerLeaseId: lease.id,
	});
	t.processes.update(input.instanceId, {
		currentExecution: { kind: "worker_start", id: start.id },
	});
	return { lease, start };
}

async function acknowledgeAcceptedTurn(
	handler: ReturnType<typeof createTestIpcHandler>,
	input: { instanceId: string; workerId: string; turnRecordId: string },
) {
	const process = t.processes.getById(input.instanceId);
	if (process?.currentExecution?.kind !== "worker_start") {
		throw new Error("Fixture process has no current worker start");
	}
	handler.handleMessage(
		baseEnvelope("worker.turn_started", input.instanceId, input.workerId, {
			startRecordId: process.currentExecution.id,
			proposedTurnRecordId: input.turnRecordId,
		}),
	);
	await flushAsyncWork();
}

function baseEnvelope(
	type: string,
	instanceId: string,
	workerId: string,
	payload: unknown,
): IpcEnvelope {
	return {
		protocol: IPC_PROTOCOL_VERSION,
		messageId: crypto.randomUUID(),
		type,
		instanceId,
		workerId,
		sentAt: new Date().toISOString(),
		payload,
	};
}

beforeEach(() => {
	t = createTestDeps();
});

describe("createIpcHandler", () => {
	it("handles worker.hello and updates lease", () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test1";
		t.leases.create({ instanceId: process.id, workerId, state: "spawning" });

		const handler = createTestIpcHandler(t);

		handler.handleMessage(
			baseEnvelope("worker.hello", process.id, workerId, { version: "1", capabilities: [] }),
		);

		const lease = t.leases.getByInstance(process.id);
		expect(lease?.state).toBe("bootstrapping");
	});

	it("routes integration-tool cancellation from the active worker", () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_tool_cancel";
		t.leases.create({ instanceId: process.id, workerId, state: "busy" });
		const handleIntegrationToolCancel = vi.fn();
		const handler = createTestIpcHandler(t, {}, { handleIntegrationToolCancel });
		const payload = {
			turnRecordId: "trn_tool",
			toolCallId: "call_tool",
			toolName: "provider_echo",
		};

		handler.handleMessage(
			baseEnvelope("worker.integration_tool_cancel", process.id, workerId, payload),
		);

		expect(handleIntegrationToolCancel).toHaveBeenCalledWith(process.id, payload);
	});

	it("persists a question before invalidating detail and notifying once", async () => {
		const sendDurable = vi.spyOn(t.broadcaster, "sendDurable");
		const sendEphemeral = vi.spyOn(t.broadcaster, "sendEphemeral");
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_questions";
		const { lease } = setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_questions",
			turnId: "generate_plan",
		});
		const payload = {
			turnRecordId: "trn_questions",
			toolCallId: "tool_questions",
			questions: [createTestQuestion()],
		};
		const onQuestionResponse = vi.fn();
		const onQuestionRequested = vi.fn();
		const handler = createTestIpcHandler(t, { onQuestionResponse, onQuestionRequested });

		handler.handleMessage(baseEnvelope("worker.question_requested", process.id, workerId, payload));
		await flushAsyncWork();

		const request = t.questionRequests.listOpen(process.id)[0];
		if (!request) throw new Error("Expected persisted question request");
		expect(request).toMatchObject({ status: "open" });
		expect(onQuestionRequested).toHaveBeenCalledWith(process.id, request);
		expect(sendDurable).toHaveBeenCalledOnce();
		expect(sendEphemeral).toHaveBeenCalledWith(
			"process.toast",
			expect.objectContaining({
				focusTarget: { kind: "question_request", requestId: request.id },
			}),
			process.id,
		);

		handler.handleMessage(baseEnvelope("worker.question_requested", process.id, workerId, payload));
		await flushAsyncWork();

		expect(sendDurable).toHaveBeenCalledOnce();
		expect(sendEphemeral).toHaveBeenCalledOnce();
		expect(
			t.events
				.listByInstance(process.id, 20)
				.filter((event) => event.eventType === "question_requested"),
		).toHaveLength(1);

		t.leases.update(lease.id, { state: "exited", exitedAt: "2026-07-26T00:00:00.000Z" });
		const replacementWorkerId = "wkr_questions_replacement";
		const replacementLease = t.leases.create({
			instanceId: process.id,
			workerId: replacementWorkerId,
			state: "busy",
		});
		t.turnRecords.update(payload.turnRecordId, {
			acceptedWorkerLeaseId: replacementLease.id,
		});
		handler.handleMessage(
			baseEnvelope("worker.question_requested", process.id, replacementWorkerId, payload),
		);
		await flushAsyncWork();

		expect(t.questionRequests.getById(request.id)).toMatchObject({ status: "open" });
		expect(sendDurable).toHaveBeenCalledOnce();
		expect(sendEphemeral).toHaveBeenCalledOnce();

		t.questionRequests.answer({
			id: request.id,
			answers: ["Safe"],
			actor: { id: "operator", kind: "user", provider: null },
		});
		handler.handleMessage(
			baseEnvelope("worker.question_requested", process.id, replacementWorkerId, payload),
		);
		await flushAsyncWork();

		expect(onQuestionResponse).toHaveBeenCalledWith(process.id, replacementWorkerId, {
			turnRecordId: payload.turnRecordId,
			toolCallId: payload.toolCallId,
			answers: ["Safe"],
		});
	});

	it("reports question persistence failures instead of leaving a rejected promise unhandled", async () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_question_failure";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_question_failure",
			turnId: "generate_plan",
		});
		const payload = {
			turnRecordId: "trn_question_failure",
			toolCallId: "tool_question_failure",
			questions: [
				createTestQuestion({
					question: "Choose",
					options: [{ id: "question_1_option_1", label: "One", details: null }],
				}),
			],
		};
		const onWorkerFailed = vi.fn();
		const handler = createTestIpcHandler(t, { onWorkerFailed });
		handler.handleMessage(baseEnvelope("worker.question_requested", process.id, workerId, payload));
		await flushAsyncWork();

		handler.handleMessage(
			baseEnvelope("worker.question_requested", process.id, workerId, {
				...payload,
				questions: [{ ...payload.questions[0], question: "Changed" }],
			}),
		);
		await flushAsyncWork();

		expect(onWorkerFailed).toHaveBeenCalledWith(
			process.id,
			workerId,
			"Worker question request could not be persisted",
		);
	});

	it("handles worker.ready, updates lease, and persists rootEntry", async () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test2";
		const { lease } = setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_ready",
			turnId: "generate_plan",
		});
		t.leases.update(lease.id, { state: "bootstrapping" });

		const handler = createTestIpcHandler(t);

		handler.handleMessage(
			baseEnvelope("worker.ready", process.id, workerId, {
				receipt: t.leases.getById(lease.id)?.bootstrapReceipt,
				resumed: false,
				primaryTreeFile: "/tmp/s",
				workspaceRoot: "/tmp/w",
				aggregatedAgentsSources: [],
				loadedSkills: [],
				loadedAgentsFiles: [],
				loadedSkillFiles: [],
				rootEntryId: "user-1",
			}),
		);
		await flushAsyncWork();

		expect(t.leases.getByInstance(process.id)).toMatchObject({
			state: "idle",
			lastHeartbeatAt: expect.any(String),
		});
		expect(JSON.parse(t.processes.getById(process.id)?.stateJson ?? "null")).toMatchObject({
			semanticEntryRefs: {
				rootEntry: { entryId: "user-1", turnRecordId: null },
			},
		});
	});

	it("handles worker.heartbeat and updates timestamp", () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test3";
		t.leases.create({ instanceId: process.id, workerId, state: "idle" });

		const handler = createTestIpcHandler(t);

		handler.handleMessage(
			baseEnvelope("worker.heartbeat", process.id, workerId, {
				state: "busy",
				lastSequenceConsumed: 0,
				currentSelectedTurnId: "generate_plan",
			}),
		);

		const lease = t.leases.listActive().find((lease) => lease.workerId === workerId);
		expect(lease?.lastHeartbeatAt).not.toBeNull();
		expect(lease?.state).toBe("idle");
	});

	it("handles worker.state via the worker lease lifecycle", () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_state_busy";
		t.leases.create({ instanceId: process.id, workerId, state: "idle" });

		const handler = createTestIpcHandler(t);

		handler.handleMessage(
			baseEnvelope("worker.state", process.id, workerId, {
				from: "idle",
				to: "busy",
				reason: "turn_execution",
			}),
		);

		const lease = t.leases.getByInstance(process.id);
		expect(lease?.state).toBe("busy");
		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "worker.state",
					instanceId: process.id,
					payload: expect.objectContaining({
						workerId,
						state: "busy",
						previousState: "idle",
						worker: expect.objectContaining({ state: "busy" }),
					}),
				}),
			]),
		);
	});

	it("handles worker.input_consumed, marks input consumed, and persists primary-path leaf facts", async () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test4";
		t.leases.create({ instanceId: process.id, workerId, state: "idle" });
		const input = t.inputs.create({
			instanceId: process.id,
			sequence: 1,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "hi",
		});

		const handler = createTestIpcHandler(t);

		handler.handleMessage(
			baseEnvelope("worker.input_consumed", process.id, workerId, {
				inputId: input.id,
				sequence: 1,
				deliveryMode: "prompt",
				currentPrimaryPathLeafId: "turn-1",
				rootEntryId: "user-1",
			}),
		);
		await flushAsyncWork();

		const row = t.inputs.listByInstance(process.id).find((i) => i.id === input.id);
		expect(row?.consumedAt).not.toBeNull();
		expect(JSON.parse(t.processes.getById(process.id)?.stateJson ?? "null")).toMatchObject({
			semanticEntryRefs: {
				currentPrimaryPathLeaf: { entryId: "turn-1", turnRecordId: null },
				rootEntry: { entryId: "user-1", turnRecordId: null },
			},
		});
	});

	it("updates only the targeted semantic ref for review-branch targeted input acknowledgements", async () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "review_plan",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				semanticEntryRefs: {
					currentPrimaryPathLeaf: { entryId: "turn-primary", turnRecordId: "trn_primary" },
					review: { entryId: "turn-review", turnRecordId: "trn_review" },
					rootEntry: { entryId: "user-1", turnRecordId: null },
				},
			}),
		});
		const workerId = "wkr_targeted_review";
		t.leases.create({ instanceId: process.id, workerId, state: "idle" });
		const input = t.inputs.create({
			instanceId: process.id,
			sequence: 1,
			source: "action_prompt",
			kind: "instruction",
			target: { semanticRef: "review" },
			bodyMarkdown: "Keep this on the review branch.",
		});

		const handler = createTestIpcHandler(t);
		handler.handleMessage(
			baseEnvelope("worker.input_consumed", process.id, workerId, {
				inputId: input.id,
				sequence: 1,
				deliveryMode: "append_message",
				rootEntryId: "user-1",
				targetSemanticRef: "review",
				targetEntryId: "user-3",
			}),
		);
		await flushAsyncWork();

		expect(JSON.parse(t.processes.getById(process.id)?.stateJson ?? "null")).toMatchObject({
			semanticEntryRefs: {
				currentPrimaryPathLeaf: { entryId: "turn-primary", turnRecordId: "trn_primary" },
				review: { entryId: "user-3", turnRecordId: null },
				rootEntry: { entryId: "user-1", turnRecordId: null },
			},
		});
	});

	it("updates only the targeted product ref for product-branch targeted input acknowledgements", async () => {
		const process = t.processes.create({
			processId: "local_repo_change_process",
			selectedTurnId: "simplify_implementation",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				productRefs: {
					"simplification-plan": { entryId: "turn-simplify", turnRecordId: "trn_simplify" },
				},
				semanticEntryRefs: {
					currentPrimaryPathLeaf: { entryId: "turn-primary", turnRecordId: "trn_primary" },
					rootEntry: { entryId: "user-1", turnRecordId: null },
				},
			}),
		});
		const workerId = "wkr_targeted_product";
		t.leases.create({ instanceId: process.id, workerId, state: "idle" });
		const input = t.inputs.create({
			instanceId: process.id,
			sequence: 1,
			source: "action_prompt",
			kind: "instruction",
			target: { productName: "simplification-plan" },
			bodyMarkdown: "Keep this on the simplification branch.",
		});

		const handler = createTestIpcHandler(t);
		handler.handleMessage(
			baseEnvelope("worker.input_consumed", process.id, workerId, {
				inputId: input.id,
				sequence: 1,
				deliveryMode: "append_message",
				rootEntryId: "user-1",
				targetProductName: "simplification-plan",
				targetEntryId: "user-3",
			}),
		);
		await flushAsyncWork();

		expect(JSON.parse(t.processes.getById(process.id)?.stateJson ?? "null")).toMatchObject({
			productRefs: {
				"simplification-plan": { entryId: "user-3", turnRecordId: null },
			},
			semanticEntryRefs: {
				currentPrimaryPathLeaf: { entryId: "turn-primary", turnRecordId: "trn_primary" },
				rootEntry: { entryId: "user-1", turnRecordId: null },
			},
		});
	});

	it("handles worker.event and records + broadcasts raw + normalized assistant partial frames", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test5";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_stream_live",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_stream_live",
		});
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.stream.delta",
				selectedTurnId: "generate_plan",
				data: { chunk: "x", streamType: "text", timestamp: "2026-04-14T10:00:01.000Z" },
			}),
		);
		await flushAsyncWork();

		expect(
			t.events
				.listByInstance(process.id, 5)
				.some(
					(e) =>
						e.eventType === "pi.stream.delta" &&
						(e.data as { turnRecordId?: string }).turnRecordId === "trn_stream_live",
				),
		).toBe(true);
		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "pi.stream.delta",
					instanceId: process.id,
					payload: expect.objectContaining({
						chunk: "x",
						turnRecordId: "trn_stream_live",
					}),
				}),
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL,
					instanceId: process.id,
					payload: expect.objectContaining({
						turnRecordId: "trn_stream_live",
						text: "x",
						streamType: "text",
					}),
				}),
			]),
		);
	});

	it("broadcasts cumulative normalized usage frames when pi.usage arrives", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test_usage";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_usage_live",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_usage_live",
		});
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.usage",
				selectedTurnId: "generate_plan",
				data: {
					input: 100,
					output: 20,
					reasoning: 12,
					cacheRead: 300,
					cacheWrite: 40,
					totalTokens: 460,
					cost: {
						input: 1,
						output: 2,
						cacheRead: 0.5,
						cacheWrite: 0.25,
						total: 3.75,
					},
					timestamp: "2026-04-14T10:00:02.000Z",
				},
			}),
		);
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.usage",
				selectedTurnId: "generate_plan",
				data: {
					input: 80,
					output: 30,
					reasoning: 8,
					cacheRead: 5,
					cacheWrite: 0,
					totalTokens: 115,
					cost: {
						input: 0.75,
						output: 0.5,
						cacheRead: 0.125,
						cacheWrite: 0,
						total: 1.375,
					},
					timestamp: "2026-04-14T10:00:03.000Z",
				},
			}),
		);

		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "pi.usage",
					instanceId: process.id,
					payload: expect.objectContaining({
						turnRecordId: "trn_usage_live",
						input: 100,
					}),
				}),
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.USAGE_UPDATED,
					instanceId: process.id,
					payload: {
						turnRecordId: "trn_usage_live",
						piTurnId: null,
						usage: {
							input: 100,
							output: 20,
							reasoning: 12,
							cacheRead: 300,
							cacheWrite: 40,
							totalTokens: 460,
							cost: {
								input: 1,
								output: 2,
								cacheRead: 0.5,
								cacheWrite: 0.25,
								total: 3.75,
							},
							requestCount: 1,
							maxInputTokens: 100,
						},
						timestamp: "2026-04-14T10:00:02.000Z",
					},
				}),
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.USAGE_UPDATED,
					instanceId: process.id,
					payload: {
						turnRecordId: "trn_usage_live",
						piTurnId: null,
						usage: {
							input: 180,
							output: 50,
							reasoning: 20,
							cacheRead: 305,
							cacheWrite: 40,
							totalTokens: 575,
							cost: {
								input: 1.75,
								output: 2.5,
								cacheRead: 0.625,
								cacheWrite: 0.25,
								total: 5.125,
							},
							requestCount: 2,
							maxInputTokens: 100,
						},
						timestamp: "2026-04-14T10:00:03.000Z",
					},
				}),
			]),
		);
	});

	it("forwards tool events as raw diagnostics and normalized primary-path tool frames", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test_tool";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_tool_live",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_tool_live",
		});

		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.tool.call",
				selectedTurnId: "generate_plan",
				data: {
					toolCallId: "tool-1",
					toolName: "plan_saved",
					turnId: "t1",
					args: { summary: "hello" },
					timestamp: "2026-04-14T10:00:02.000Z",
				},
			}),
		);
		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "pi.tool.started",
					instanceId: process.id,
					payload: expect.objectContaining({
						toolName: "plan_saved",
						turnRecordId: "trn_tool_live",
					}),
				}),
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED,
					instanceId: process.id,
					payload: expect.objectContaining({
						turnRecordId: "trn_tool_live",
						toolCallId: "tool-1",
						toolName: "plan_saved",
						arguments: { summary: "hello" },
					}),
				}),
			]),
		);

		frames.length = 0;

		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.tool.result",
				selectedTurnId: "generate_plan",
				data: {
					toolCallId: "tool-1",
					toolName: "plan_saved",
					result: { ok: true },
					isError: false,
					turnId: "t1",
					timestamp: "2026-04-14T10:00:03.000Z",
				},
			}),
		);
		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "pi.tool.completed",
					instanceId: process.id,
					payload: expect.objectContaining({
						toolName: "plan_saved",
						turnRecordId: "trn_tool_live",
					}),
				}),
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED,
					instanceId: process.id,
					payload: expect.objectContaining({
						turnRecordId: "trn_tool_live",
						toolCallId: "tool-1",
						toolName: "plan_saved",
						result: { ok: true },
						isError: false,
					}),
				}),
			]),
		);
	});

	it("canonicalizes fallback toolCallIds so call/result events share the same durable identity", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test_tool_fallback";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_tool_fallback",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_tool_fallback",
		});
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.tool.call",
				selectedTurnId: "generate_plan",
				data: {
					toolName: "run_tests",
					turnId: "turn-1",
					args: { suite: "unit" },
					timestamp: "2026-04-14T10:00:02.000Z",
				},
			}),
		);
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.tool.result",
				selectedTurnId: "generate_plan",
				data: {
					toolName: "run_tests",
					result: { ok: true },
					isError: false,
					turnId: "turn-1",
					timestamp: "2026-04-14T10:00:03.000Z",
				},
			}),
		);

		const persistedEvents = t.events
			.listByInstance(process.id, 10)
			.filter((event) => event.eventType === "pi.tool.call" || event.eventType === "pi.tool.result")
			.reverse();
		const startedPayload = persistedEvents[0]?.data as { toolCallId?: string } | undefined;
		const completedPayload = persistedEvents[1]?.data as { toolCallId?: string } | undefined;
		const startedFrame = frames.find(
			(frame) => frame.type === WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED,
		);
		const completedFrame = frames.find(
			(frame) => frame.type === WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED,
		);

		expect(startedPayload?.toolCallId).toMatch(/^run_tests:2026-04-14T10:00:02.000Z:1$/);
		expect(completedPayload?.toolCallId).toBe(startedPayload?.toolCallId);
		expect(startedFrame?.payload).toMatchObject({ toolCallId: startedPayload?.toolCallId });
		expect(completedFrame?.payload).toMatchObject({ toolCallId: startedPayload?.toolCallId });
	});

	it("starts a new fallback tool-call identity after acknowledged handler recreation", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test_tool_hydrated";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_tool_hydrated",
			turnId: "generate_plan",
		});
		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_tool_hydrated",
		});
		t.events.create({
			instanceId: process.id,
			eventType: "pi.tool.call",
			data: {
				turnRecordId: "trn_tool_hydrated",
				toolName: "run_tests",
				turnId: "turn-2",
				args: { suite: "unit" },
				timestamp: "2026-04-14T10:10:02.000Z",
			},
		});

		const recreatedHandler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(recreatedHandler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_tool_hydrated",
		});
		recreatedHandler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.tool.result",
				selectedTurnId: "generate_plan",
				data: {
					toolName: "run_tests",
					result: { ok: true },
					isError: false,
					turnId: "turn-2",
					timestamp: "2026-04-14T10:10:03.000Z",
				},
			}),
		);

		const completedPayload = t.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "pi.tool.result")?.data as
			| { toolCallId?: string }
			| undefined;
		const completedFrame = frames.find(
			(frame) => frame.type === WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED,
		);

		expect(completedPayload?.toolCallId).toBe("run_tests:2026-04-14T10:10:03.000Z:1");
		expect(completedFrame?.payload).toMatchObject({
			toolCallId: "run_tests:2026-04-14T10:10:03.000Z:1",
		});
	});

	it("emits normalized label change frames while keeping raw pi diagnostics available", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test_label";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_label_live",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_label_live",
		});
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.label.changed",
				selectedTurnId: "generate_plan",
				data: {
					turnId: "turn-5",
					targetId: "assistant-plan",
					label: "approved-plan",
					timestamp: "2026-04-14T10:00:04.000Z",
				},
			}),
		);

		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "pi.label.changed",
					instanceId: process.id,
					payload: expect.objectContaining({
						targetId: "assistant-plan",
						label: "approved-plan",
						turnRecordId: "trn_label_live",
					}),
				}),
				expect.objectContaining({
					type: WS_PRIMARY_PATH_TYPES.LABEL_CHANGED,
					instanceId: process.id,
					payload: expect.objectContaining({
						turnRecordId: "trn_label_live",
						targetId: "assistant-plan",
						label: "approved-plan",
					}),
				}),
			]),
		);
	});

	it("persists worker.error diagnostics without emitting a toast frame", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test_diag";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_diag_live",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t, {}, { toastTtlMs: 1234 });
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_diag_live",
		});
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "worker.error",
				selectedTurnId: "generate_plan",
				data: {
					code: "guard.turn_inactivity_timeout",
					message: "Turn 'implement' exceeded inactivity timeout after 25ms without Pi activity",
					turnRecordId: "trn_diag_live",
					timestamp: "2026-04-14T10:00:04.000Z",
				},
			}),
		);

		expect(
			t.events
				.listByInstance(process.id, 10)
				.some(
					(event) =>
						event.eventType === "worker.error" &&
						(event.data as { code?: string }).code === "guard.turn_inactivity_timeout",
				),
		).toBe(true);
		expect(
			frames.some((frame) => frame.type === "process.toast" && frame.instanceId === process.id),
		).toBe(false);
	});

	it("forwards pi.error raw frames and keeps worker.error diagnostics toast-free", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test_pi_diag";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_diag_live",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t, {}, { toastTtlMs: 1234 });
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_diag_live",
		});
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.error",
				selectedTurnId: "generate_plan",
				data: {
					message: "connection refused",
					timestamp: "2026-04-14T10:00:04.000Z",
				},
			}),
		);

		expect(frames).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "pi.error",
					instanceId: process.id,
					payload: expect.objectContaining({
						message: "connection refused",
						turnRecordId: "trn_diag_live",
					}),
				}),
			]),
		);

		frames.length = 0;
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "worker.error",
				selectedTurnId: "generate_plan",
				data: {
					code: "pi.request_failed",
					message: "connection refused",
					turnRecordId: "trn_diag_live",
					details: { attempt: 2 },
					timestamp: "2026-04-14T10:00:05.000Z",
				},
			}),
		);

		expect(
			frames.some((frame) => frame.type === "process.toast" && frame.instanceId === process.id),
		).toBe(false);
	});

	it("persists retry scheduling traces without emitting a toast", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test_retry_trace";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_retry_live",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t, {}, { toastTtlMs: 1234 });
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_retry_live",
		});
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "worker.trace",
				selectedTurnId: "generate_plan",
				data: {
					code: "pi.retry_scheduled",
					message: "Retry 1/3 scheduled in 2000ms: Request timed out.",
					turnRecordId: "trn_retry_live",
					details: { attempt: 1, maxAttempts: 3, delayMs: 2000 },
					timestamp: "2026-04-14T10:00:04.000Z",
				},
			}),
		);

		expect(
			frames.some((frame) => frame.type === "process.toast" && frame.instanceId === process.id),
		).toBe(false);
	});

	it("can mirror worker.event payloads to an injected logger", async () => {
		const workerEventLogger = vi.fn();
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test_log";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_log_live",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t, {}, { workerEventLogger });
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_log_live",
		});
		handler.handleMessage(
			baseEnvelope("worker.event", process.id, workerId, {
				eventType: "pi.stream.delta",
				selectedTurnId: "generate_plan",
				data: {
					chunk: "hello",
					streamType: "text",
					timestamp: "2026-04-14T10:00:05.000Z",
				},
			}),
		);

		expect(workerEventLogger).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: process.id,
				workerId,
				eventType: "pi.stream.delta",
				selectedTurnId: "generate_plan",
				timestamp: "2026-04-14T10:00:05.000Z",
				serverObservedAt: expect.any(String),
				serverObservedLatencyMs: expect.any(Number),
				turnRecordId: "trn_log_live",
				data: expect.objectContaining({
					chunk: "hello",
					streamType: "text",
					turnRecordId: "trn_log_live",
				}),
			}),
		);
	});

	it("records turn starts before outcomes and finalizes successful turn records", async () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test6";
		const { start } = setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_plan_1",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_plan_1",
		});

		expect(t.turnRecords.getById("trn_plan_1")?.status).toBe("running");
		expect(t.processes.getById(process.id)?.currentExecution).toEqual({
			kind: "worker_start",
			id: start.id,
		});

		handler.handleMessage(
			baseEnvelope("worker.turn_outcome", process.id, workerId, {
				turnRecordId: "trn_plan_1",
				turnId: "generate_plan",
				outcome: "plan_saved",
				pathType: "primary",
				resultPiEntryId: "turn-1",
				rootEntryId: "user-1",
				turnResultMarkdown: "## Plan",
				params: {
					summary: "Initial plan",
					acceptanceCriteria: ["A"],
					planMarkdown: "## Plan",
				},
			}),
		);
		await flushAsyncWork();

		expect(t.processes.getById(process.id)?.selectedTurnId).toBe("plan_review");
		expect(t.processes.getById(process.id)?.planRevision).toBe(1);
		expect(t.turnRecords.getById("trn_plan_1")?.status).toBe("succeeded");
		expect(t.turnRecords.getById("trn_plan_1")?.turnResultMarkdown).toBe("## Plan");
		expect(t.processes.getById(process.id)?.currentExecution).toBeNull();
		expect(JSON.parse(t.processes.getById(process.id)?.stateJson ?? "null")).toMatchObject({
			semanticEntryRefs: {
				plan: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
				currentPrimaryPathLeaf: { entryId: "turn-1", turnRecordId: "trn_plan_1" },
				rootEntry: { entryId: "user-1", turnRecordId: null },
			},
		});
		const annotations = t.turnAnnotations.listByInstance(process.id);
		expect(annotations).toHaveLength(1);
		expect(annotations[0]).toMatchObject({
			annotationType: "turn_milestone",
			annotationKey: "turn_milestone:trn_plan_1",
			payload: {
				turnId: "generate_plan",
				turnType: "llm",
				pathType: "primary",
				outcome: "plan_saved",
			},
		});
		expect(annotations[0]?.references).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "turn_record", turnRecordId: "trn_plan_1" }),
			]),
		);
	});

	it("rejects stale acknowledged turn starts without replacing current execution", async () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_stale_start";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_current",
			turnId: "generate_plan",
		});
		const onWorkerFailed = vi.fn();

		const handler = createTestIpcHandler(t, { onWorkerFailed });
		handler.handleMessage(
			baseEnvelope("worker.turn_started", process.id, workerId, {
				startRecordId: "tsr_stale",
				proposedTurnRecordId: "trn_stale",
			}),
		);
		await flushAsyncWork();

		expect(onWorkerFailed).toHaveBeenCalled();
		expect(t.processes.getById(process.id)?.lifecycleStatus).toBe("active");
		expect(t.processes.getById(process.id)?.currentExecution).toEqual({
			kind: "worker_start",
			id: "tsr_trn_current",
		});
		expect(t.turnRecords.getById("trn_current")?.status).toBe("running");
	});

	it("normalizes stale turn outcomes from the active worker into worker failure", async () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_stale_outcome";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_current",
			turnId: "generate_plan",
		});

		const handler = createTestIpcHandler(t);
		handler.handleMessage(
			baseEnvelope("worker.turn_outcome", process.id, workerId, {
				turnRecordId: "trn_stale",
				turnId: "generate_plan",
				outcome: "plan_saved",
				pathType: "primary",
				params: {
					summary: "Stale plan",
					acceptanceCriteria: ["A"],
					planMarkdown: "## Stale Plan",
				},
			}),
		);
		await flushAsyncWork();

		expect(t.processes.getById(process.id)?.selectedTurnId).toBe("generate_plan");
		expect(t.processes.getById(process.id)?.lifecycleStatus).toBe("error");
		expect(t.processes.getById(process.id)?.currentExecution).toEqual({
			kind: "worker_start",
			id: "tsr_trn_current",
		});
		expect(t.processes.getById(process.id)?.planRevision).toBe(0);
		expect(t.turnRecords.getById("trn_current")?.status).toBe("failed");
	});

	it("records failed turn records and parks lifecycle in error before lifecycle parking", async () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_turn_fail";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_impl_1",
			turnId: "implement",
		});

		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_impl_1",
		});

		handler.handleMessage(
			baseEnvelope("worker.turn_failed", process.id, workerId, {
				turnRecordId: "trn_impl_1",
				turnId: "implement",
				pathType: "primary",
				errorSummary: "Result branch drifted",
				errorClass: "infrastructure",
				failureCode: "branch_drift",
				failureDetails: promptBranchDriftDetails,
			}),
		);
		await flushAsyncWork();

		expect(t.turnRecords.getById("trn_impl_1")?.status).toBe("failed");
		expect(t.processes.getById(process.id)?.currentExecution).toEqual({
			kind: "worker_start",
			id: "tsr_trn_impl_1",
		});
		expect(t.processes.getById(process.id)?.lifecycleStatus).toBe("error");
		const turnFailedEvent = t.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "turn_failed");
		expect(turnFailedEvent?.data).toMatchObject({
			turnRecordId: "trn_impl_1",
			failureCode: "branch_drift",
			failureDetails: promptBranchDriftDetails,
		});
	});

	it("keeps the process parked after compatibility parking", async () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_parked_compat";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_impl_auto_1",
			turnId: "implement",
		});

		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_impl_auto_1",
		});

		handler.handleMessage(
			baseEnvelope("worker.turn_failed", process.id, workerId, {
				turnRecordId: "trn_impl_auto_1",
				turnId: "implement",
				pathType: "primary",
				errorSummary: "LLM timeout",
				errorClass: "llm_error",
			}),
		);
		await flushAsyncWork();

		handler.handleMessage(
			baseEnvelope("worker.lifecycle_parked", process.id, workerId, {
				selectedTurnId: "implement",
				reason: "LLM timeout",
				errorClass: "llm_error",
			}),
		);
		await flushAsyncWork();

		expect(t.processes.getById(process.id)?.selectedTurnId).toBe("implement");
		expect(t.processes.getById(process.id)?.lifecycleStatus).toBe("error");
		expect(t.processes.getById(process.id)?.currentExecution).toEqual({
			kind: "worker_start",
			id: "tsr_trn_impl_auto_1",
		});
	});

	it("silently ignores messages for non-existent processes", () => {
		const handler = createTestIpcHandler(t);

		expect(() => {
			handler.handleMessage(
				baseEnvelope("worker.hello", "nonexistent-agent", "wkr_orphan", {
					version: "1",
					capabilities: [],
				}),
			);
			handler.handleMessage(
				baseEnvelope("worker.heartbeat", "nonexistent-agent", "wkr_orphan", {
					state: "idle",
					lastSequenceConsumed: 0,
					currentSelectedTurnId: "generate_plan",
				}),
			);
			handler.handleMessage(
				baseEnvelope("worker.event", "nonexistent-agent", "wkr_orphan", {
					eventType: "pi.stream.delta",
					selectedTurnId: "generate_plan",
					data: { chunk: "x" },
				}),
			);
		}).not.toThrow();
	});

	it("handles worker.failed and updates lease + invokes callback", () => {
		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const workerId = "wkr_test7";
		t.leases.create({ instanceId: process.id, workerId, state: "busy" });

		const onWorkerFailed = vi.fn();
		const handler = createTestIpcHandler(t, { onWorkerFailed });

		handler.handleMessage(
			baseEnvelope("worker.failed", process.id, workerId, {
				state: "busy",
				errorCode: "E1",
				message: "boom",
				errorClass: "llm_error",
				selectedTurnId: "generate_plan",
			}),
		);

		expect(t.leases.getByInstance(process.id)?.state).toBe("failed");
		expect(onWorkerFailed).toHaveBeenCalledWith(process.id, workerId, "boom");
	});

	it("handles llm_review turn outcomes and emits review.updated + process.event", async () => {
		const frames: WsFrame[] = [];
		vi.spyOn(t.broadcaster, "broadcast").mockImplementation((frame) => {
			frames.push(frame);
		});

		const process = t.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "run_llm_review",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				semanticEntryRefs: {
					currentPrimaryPathLeaf: { entryId: "turn-1", turnRecordId: "trn_impl_1" },
				},
			}),
		});
		const workerId = "wkr_review_done";
		setupAcceptedTurn({
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_review_1",
			turnId: "run_llm_review",
		});

		const handler = createTestIpcHandler(t);
		await acknowledgeAcceptedTurn(handler, {
			instanceId: process.id,
			workerId,
			turnRecordId: "trn_review_1",
		});

		handler.handleMessage(
			baseEnvelope("worker.turn_outcome", process.id, workerId, {
				turnRecordId: "trn_review_1",
				turnId: "run_llm_review",
				outcome: "issues_found",
				pathType: "root_branch",
				resultPiEntryId: "turn-2",
				rootEntryId: "user-1",
				params: {
					reviewMarkdown: "## Found issues",
					issueCount: 2,
				},
			}),
		);
		await flushAsyncWork();

		expect(t.processes.getById(process.id)?.selectedTurnId).toBe("address_review");
		expect(t.turnRecords.getById("trn_review_1")?.status).toBe("succeeded");
		expect(t.processes.getById(process.id)?.currentExecution).toMatchObject({
			kind: "worker_start",
		});
		expect(JSON.parse(t.processes.getById(process.id)?.stateJson ?? "null")).toMatchObject({
			semanticEntryRefs: {
				review: { entryId: "turn-2", turnRecordId: "trn_review_1" },
				currentPrimaryPathLeaf: { entryId: "turn-1", turnRecordId: "trn_impl_1" },
				rootEntry: { entryId: "user-1", turnRecordId: null },
			},
		});
		const durableCalls = frames.map((frame) => frame.type);
		expect(durableCalls).toContain("review.updated");
		expect(durableCalls).toContain("process.event");

		const reviewFrame = frames.find((frame) => frame.type === "review.updated");
		expect(reviewFrame?.payload).toMatchObject({
			hasIssues: true,
			issueCount: 2,
			nextTurnId: null,
		});
	});
});
