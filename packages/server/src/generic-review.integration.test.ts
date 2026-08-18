import { randomUUID } from "node:crypto";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	type Codec,
	createEmptyStructuralProcessState,
	defineModelProvider,
	defineModelProviders,
	defineProcess,
	humanTurn,
	type LeitwerkExtensionModule,
	type LlmTurnDefinition,
	llmTurn,
	parseStructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import { createTestApp, type TestApp } from "@leitwerk-dev/test-support/integration";
import { createIpcMessage } from "@leitwerk-dev/worker-protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const emptyCodec: Codec<Record<string, never>> = {
	parse() {
		return {};
	},
	serialize(value) {
		return value;
	},
};

const structuralStateCodec: Codec<ReturnType<typeof createEmptyStructuralProcessState>> = {
	parse(value) {
		return parseStructuralProcessState(value);
	},
	serialize(value) {
		return value;
	},
};

function createLlmTurn<TOutcome extends string>(
	id: string,
	outcomes: NonNullable<LlmTurnDefinition<TOutcome>["outcomes"]>,
): LlmTurnDefinition<TOutcome> {
	return llmTurn({
		availableTools: [],
		description: id,
		completionMode: "turn_end",
		branchType: "primary",
		context: "full",
		prompt: async () => id,
		outcomes,
	});
}

const generatePlanTurn: LlmTurnDefinition<"plan_saved"> = {
	...createLlmTurn("generate_plan", {
		plan_saved: {
			description: "plan saved",
			to: "run_llm_review",
			parameters: {
				summary: {
					type: "string",
					description: "summary",
					required: true,
					requiredErrorCode: "summary_required",
				},
				acceptanceCriteria: {
					type: "array",
					description: "criteria",
					items: { type: "string" },
					required: true,
					requiredErrorCode: "acceptance_criteria_required",
					minItems: 1,
					minItemsErrorCode: "acceptance_criteria_required",
				},
				planMarkdown: {
					type: "string",
					description: "plan markdown",
					required: true,
					requiredErrorCode: "plan_markdown_required",
				},
			},
		},
	}),
	resultSemanticRef: "plan",
};

const runLlmReviewTurn: LlmTurnDefinition<"no_issues" | "issues_found"> = {
	...createLlmTurn("run_llm_review", {
		no_issues: {
			description: "no issues",
			parameters: {},
			to: "plan_review",
		},
		issues_found: {
			description: "issues found",
			to: "plan_review",
			parameters: {
				reviewMarkdown: {
					type: "string",
					description: "review",
					required: true,
					requiredErrorCode: "review_markdown_required",
				},
				issueCount: {
					type: "number",
					description: "count",
					minimum: 0,
					minimumErrorCode: "invalid_issue_count",
					invalidErrorCode: "invalid_issue_count",
				},
			},
		},
	}),
	resultSemanticRef: "review",
};

const planReviewTurn = humanTurn({
	description: "Review the generated plan",
	actions: {
		approve_plan: {
			label: "Approve plan",
			acceptanceState: "accepted",
			trigger: "plan_approved",
			to: "implement",
			effect: ({ ctx }) => ({ state: { ...ctx.state } }),
			preview: { kind: "trigger", trigger: "plan_approved" },
			schedulable: true,
		},
		request_revision: {
			label: "Request revision",
			acceptanceState: "requires_changes",
			trigger: "revision_requested",
			to: "generate_plan",
			form: {
				id: "request_revision_form",
				title: "Request revision",
				fields: [
					{
						id: "message",
						label: "Message",
						kind: "textarea",
						primaryPrompt: true,
						required: true,
					},
				],
			},
			effect: ({ input, ctx }) => {
				const message = typeof input.message === "string" ? input.message.trim() : "";
				if (!message) {
					throw new Error("message is required");
				}
				return { state: { ...ctx.state } };
			},
			preview: { kind: "trigger", trigger: "revision_requested" },
			schedulable: true,
		},
	},
});

const implementTurn = createLlmTurn("implement", {
	done: {
		description: "done",
		parameters: {
			summary: {
				type: "string",
				description: "summary",
				required: true,
				requiredErrorCode: "summary_required",
			},
		},
	},
});

const sideEffectPlanReviewTurn = humanTurn({
	description: "Review the generated plan with a side-effect side-effect execute-only action",
	actions: {
		approve_legacy: {
			label: "Approve plan",
			acceptanceState: "accepted",
			trigger: "legacy_approved",
			to: "legacy_implement",
			preview: { kind: "trigger", trigger: "legacy_approved" },
			schedulable: true,
		},
	},
});

const sideEffectImplementTurn = createLlmTurn("legacy_implement", {
	done: {
		description: "done",
		parameters: {},
	},
});

const genericPlanReviewProcess = defineProcess<
	Record<string, never>,
	ReturnType<typeof createEmptyStructuralProcessState>
>({
	id: "generic_plan_review_process",
	displayName: "Generic Plan Review Test Process",
	entry: "generate_plan",
	turns: {
		generate_plan: generatePlanTurn,
		run_llm_review: runLlmReviewTurn,
		implement: implementTurn,
		plan_review: planReviewTurn,
	},
	paramsCodec: emptyCodec,
	stateCodec: structuralStateCodec,
	initialState() {
		return createEmptyStructuralProcessState();
	},
});

const sideEffectExecuteReviewProcess = defineProcess<
	Record<string, never>,
	ReturnType<typeof createEmptyStructuralProcessState>
>({
	id: "side_effect_execute_review_process",
	displayName: "Side-Effect Execute Review Test Process",
	entry: "legacy_plan_review",
	turns: {
		legacy_plan_review: sideEffectPlanReviewTurn,
		legacy_implement: sideEffectImplementTurn,
	},
	paramsCodec: emptyCodec,
	stateCodec: structuralStateCodec,
	initialState() {
		return createEmptyStructuralProcessState();
	},
});

sideEffectExecuteReviewProcess.server = (api) => {
	api.action({
		id: "approve_legacy",
		label: "Approve plan",
		executionMode: "side_effect",
		async execute(_input, ctx) {
			await ctx.transition({
				turnId: "legacy_implement",
				trigger: "legacy_approved",
				state: { ...ctx.state },
			});
		},
	});
};

const genericPlanReviewExtension: LeitwerkExtensionModule = {
	manifest: { id: "generic-plan-review-test", version: "0.1.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "anthropic",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("anthropic"),
				models: () => [{ modelId: "claude-fast", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
		{
			definition: defineModelProvider({
				id: "ollama",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("ollama"),
				models: () => [{ modelId: "local-qwen", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
	setupCatalog(api) {
		api.registerProcess(genericPlanReviewProcess);
		api.registerProcess(sideEffectExecuteReviewProcess);
	},
};

let app: TestApp;

async function waitFor<T>(
	read: () => T,
	predicate: (value: T) => boolean,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = read();
		if (predicate(value)) {
			return value;
		}
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function futureIso(minutesAhead = 24 * 60): string {
	return new Date(Date.now() + minutesAhead * 60_000).toISOString();
}

function createStartingLlmTurn(input: {
	instanceId: string;
	turnId: string;
	turnRecordId: string;
}) {
	const startRecordId = `tsr_${input.turnRecordId}`;
	return app.ctx.deps.turnStarts.create({
		id: startRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		proposedTurnRecordId: input.turnRecordId,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "starting",
			start: {
				kind: "llm",
				model: {
					profileId: "fixture-profile",
					providerId: "fixture-provider",
					modelId: "fixture-model",
					thinkingLevel: "off",
				},
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "fixture-resource-digest",
				workerRuntimeProfileId: "local",
				piSettings: {},
			},
		},
	});
}

function attachWorkerReceipt(input: {
	instanceId: string;
	workerId: string;
	startRecordId: string;
}) {
	const start = app.ctx.deps.turnStarts.getById(input.startRecordId);
	if (!start || start.state.kind !== "starting" || start.state.start.kind !== "llm") {
		throw new Error(`Expected starting LLM turn '${input.startRecordId}'`);
	}
	const lease = app.ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: input.workerId,
		state: "bootstrapping",
	});
	app.ctx.deps.leases.compareAndSetBootstrapReceipt(lease.id, {
		kind: "llm",
		startRecordId: start.id,
		workerLeaseId: lease.id,
		receiptEpoch: `fixture-${start.id}`,
		verifiedResourceSnapshotDigest: start.state.start.piResourceSnapshotDigest,
		credentialRevision: 1,
		loadedResourceIds: [],
		resolvedModel: {
			providerId: start.state.start.model.providerId,
			modelId: start.state.start.model.modelId,
		},
		preparedStart: {
			pathType: "primary",
			contextMode: "full",
			startTarget: { kind: "current_leaf" },
			forkPiEntryId: null,
		},
		readyAt: new Date().toISOString(),
	});
	app.ctx.deps.leases.update(lease.id, { state: "busy" });
	return { lease, start };
}

beforeAll(async () => {
	const extensionCatalog = await buildExtensionCatalogFromModules([genericPlanReviewExtension]);
	app = await createTestApp({
		extensionCatalog,
		configureConfig(config) {
			config.pi.model_profiles = [
				{
					id: "claude_fast",
					provider: "anthropic",
					model_id: "claude-fast",
					thinking_level: "medium",
				},
				{
					id: "local_qwen",
					provider: "ollama",
					model_id: "local-qwen",
					thinking_level: "low",
				},
			];
		},
	});
});

afterAll(async () => {
	await app.close();
});

beforeEach(() => {});

describe("generic review integration", () => {
	it("runs planning -> llm_review -> human_review -> implementing without parallel review state", async () => {
		const workerHandles = new Map<
			string,
			{
				workerId: string;
				instanceId: string;
				process: object;
				send(): void;
				kill(): void;
			}
		>();

		app.ctx.supervisor.getWorker = (instanceId) => workerHandles.get(instanceId);
		app.ctx.supervisor.spawnWorker = async (instanceId) => {
			const handle = {
				workerId: `wkr_${instanceId}_${workerHandles.size + 1}`,
				instanceId,
				process: {} as never,
				send() {},
				kill() {},
			};
			workerHandles.set(instanceId, handle);
			return handle;
		};
		app.ctx.supervisor.stopWorker = async (instanceId) => {
			workerHandles.delete(instanceId);
		};

		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "active",
			selectedTurnId: "generate_plan",
			defaultModelProfileId: "claude_fast",
			selectedTurnModelProfileId: "claude_fast",
			selectedTurnModelSource: "instance_default",
		});
		const workerId = "wkr_generic_plan_review";
		workerHandles.set(process.id, {
			workerId,
			instanceId: process.id,
			process: {} as never,
			send() {},
			kill() {},
		});
		const planStart = createStartingLlmTurn({
			instanceId: process.id,
			turnId: "generate_plan",
			turnRecordId: "trn_plan_1",
		});
		app.ctx.deps.processes.update(process.id, {
			currentExecution: { kind: "worker_start", id: planStart.id },
		});
		attachWorkerReceipt({ instanceId: process.id, workerId, startRecordId: planStart.id });

		app.ctx.ipcHandler.handleMessage(
			createIpcMessage({
				type: "worker.turn_started",
				messageId: randomUUID(),
				instanceId: process.id,
				workerId,
				payload: {
					startRecordId: planStart.id,
					proposedTurnRecordId: "trn_plan_1",
				},
			}),
		);
		await waitFor(
			() => app.ctx.deps.turnStarts.getById(planStart.id),
			(start) => start?.state.kind === "accepted",
		);

		app.ctx.ipcHandler.handleMessage(
			createIpcMessage({
				type: "worker.turn_outcome",
				messageId: randomUUID(),
				instanceId: process.id,
				workerId,
				payload: {
					turnRecordId: "trn_plan_1",
					turnId: "generate_plan",
					outcome: "plan_saved",
					pathType: "primary",
					params: {
						summary: "Draft the rollout plan",
						acceptanceCriteria: ["Ship safely"],
						planMarkdown: "## Plan\n\n- Step 1",
					},
				},
			}),
		);

		const llmReviewProcess = await waitFor(
			() => app.ctx.deps.processes.getById(process.id),
			(current) =>
				current?.selectedTurnId === "run_llm_review" &&
				current.currentExecution?.kind === "worker_start",
		);
		expect(JSON.parse(llmReviewProcess?.stateJson ?? "null")).toMatchObject({});
		const reviewExecution = llmReviewProcess?.currentExecution;
		expect(reviewExecution).toMatchObject({ kind: "worker_start" });
		if (reviewExecution?.kind !== "worker_start") {
			throw new Error("Expected the review LLM turn to have a current worker start");
		}
		const reviewStart = app.ctx.deps.turnStarts.getById(reviewExecution.id);
		if (reviewStart?.state.kind === "preparation_failed") {
			throw new Error(`Review start preparation failed: ${JSON.stringify(reviewStart.state)}`);
		}
		expect(reviewStart).toMatchObject({
			turnId: "run_llm_review",
			proposedTurnRecordId: expect.any(String),
			state: { kind: "starting" },
		});
		if (!reviewStart) throw new Error("Expected a durable review start");
		const oldLease = app.ctx.deps.leases.getByInstance(process.id);
		if (oldLease) {
			app.ctx.deps.leases.update(oldLease.id, {
				state: "exited",
				exitedAt: new Date().toISOString(),
			});
		}
		const reviewWorkerId = workerHandles.get(process.id)?.workerId ?? workerId;
		attachWorkerReceipt({
			instanceId: process.id,
			workerId: reviewWorkerId,
			startRecordId: reviewStart.id,
		});

		app.ctx.ipcHandler.handleMessage(
			createIpcMessage({
				type: "worker.turn_started",
				messageId: randomUUID(),
				instanceId: process.id,
				workerId: reviewWorkerId,
				payload: {
					startRecordId: reviewStart.id,
					proposedTurnRecordId: reviewStart.proposedTurnRecordId,
				},
			}),
		);
		await waitFor(
			() => app.ctx.deps.turnStarts.getById(reviewStart.id),
			(start) => start?.state.kind === "accepted",
		);

		app.ctx.ipcHandler.handleMessage(
			createIpcMessage({
				type: "worker.turn_outcome",
				messageId: randomUUID(),
				instanceId: process.id,
				workerId: reviewWorkerId,
				payload: {
					turnRecordId: reviewStart.proposedTurnRecordId,
					turnId: "run_llm_review",
					outcome: "no_issues",
					pathType: "primary",
					params: {},
				},
			}),
		);

		const humanReviewProcess = await waitFor(
			() => app.ctx.deps.processes.getById(process.id),
			(current) => current?.lifecycleStatus === "waiting",
		);
		expect(JSON.parse(humanReviewProcess?.stateJson ?? "null")).toMatchObject({});
		expect(workerHandles.has(process.id)).toBe(false);

		const response = await fetch(
			`${app.address}/api/processes/${process.id}/actions/approve_plan`,
			{ method: "POST" },
		);
		expect(response.status).toBe(200);

		const implementingProcess = await waitFor(
			() => app.ctx.deps.processes.getById(process.id),
			(current) => current?.selectedTurnId === "implement",
		);
		expect(JSON.parse(implementingProcess?.stateJson ?? "null")).toMatchObject({});
		expect(workerHandles.has(process.id)).toBe(true);
	});

	it("persists the source of a valid next-turn model override", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});

		const response = await fetch(
			`${app.address}/api/processes/${process.id}/actions/approve_plan`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ nextTurnModelProfileId: "local_qwen" }),
			},
		);

		expect(response.status).toBe(200);
		expect(app.ctx.deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "implement",
			selectedTurnModelProfileId: "local_qwen",
			selectedTurnModelSource: "action_override",
		});
	});

	it("uses the immutable startup policy for next-turn overrides over the HTTP action route", async () => {
		const previousProcessConfigs = app.ctx.config.process_configs;
		app.ctx.config.process_configs = {
			...previousProcessConfigs,
			generic_plan_review_process: {
				allowed_model_profiles: ["local_qwen"],
				turn_configs: {},
			},
		};

		try {
			const process = app.ctx.deps.processes.create({
				processId: "generic_plan_review_process",
				lifecycleStatus: "waiting",
				selectedTurnId: "plan_review",
			});

			const response = await fetch(
				`${app.address}/api/processes/${process.id}/actions/approve_plan`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						input: {},
						nextTurnModelProfileId: "claude_fast",
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body.process).toMatchObject({
				selectedTurnId: "implement",
				selectedTurnModelProfileId: "claude_fast",
				selectedTurnModelSource: "action_override",
			});
		} finally {
			app.ctx.config.process_configs = previousProcessConfigs;
		}
	});

	it("keeps the startup model policy immutable when config objects are later mutated", async () => {
		const previousProcessConfigs = app.ctx.config.process_configs;
		app.ctx.config.process_configs = {
			...previousProcessConfigs,
			generic_plan_review_process: {
				allowed_model_profiles: ["local_qwen"],
				turn_configs: {},
			},
		};

		try {
			const process = app.ctx.deps.processes.create({
				processId: "generic_plan_review_process",
				lifecycleStatus: "waiting",
				selectedTurnId: "plan_review",
				stateJson: JSON.stringify({
					...createEmptyStructuralProcessState(),
				}),
			});

			const response = await fetch(
				`${app.address}/api/processes/${process.id}/actions/approve_plan`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						nextTurnModelProfileId: "claude_fast",
						schedule: {
							mode: "once",
							runAt: futureIso(),
						},
					}),
				},
			);
			const body = await response.json();

			expect(response.status).toBe(201);
			expect(body.kind).toBe("scheduled");
			expect(app.ctx.deps.futureExecutions.getScheduledActionByInstance(process.id)).toMatchObject({
				modelSelection: {
					modelProfileId: "claude_fast",
					provenance: { kind: "explicit", source: "action_override" },
				},
				blockedReason: null,
			});
		} finally {
			app.ctx.config.process_configs = previousProcessConfigs;
		}
	});

	it("re-resolves inherited selection from the immutable startup policy", async () => {
		const previousProcessConfigs = app.ctx.config.process_configs;
		app.ctx.config.process_configs = {
			...previousProcessConfigs,
			generic_plan_review_process: {
				allowed_model_profiles: ["local_qwen"],
				turn_configs: {},
			},
		};

		try {
			const process = app.ctx.deps.processes.create({
				processId: "generic_plan_review_process",
				lifecycleStatus: "waiting",
				selectedTurnId: "plan_review",
				defaultModelProfileId: "claude_fast",
			});

			const response = await fetch(
				`${app.address}/api/processes/${process.id}/actions/approve_plan`,
				{ method: "POST" },
			);
			expect(response.status).toBe(200);
			expect(app.ctx.deps.processes.getById(process.id)).toMatchObject({
				selectedTurnId: "implement",
				defaultModelProfileId: "claude_fast",
				selectedTurnModelProfileId: "claude_fast",
				selectedTurnModelKind: "explicit",
				selectedTurnModelSource: "instance_default",
			});
		} finally {
			app.ctx.config.process_configs = previousProcessConfigs;
		}
	});

	it("includes action capabilities in process detail responses", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});

		const response = await fetch(`${app.address}/api/processes/${process.id}`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "approve_plan",
					supportsScheduling: true,
					supportsNextTurnModelOverride: true,
					preview: expect.objectContaining({
						kind: "turn",
						turnId: "implement",
						turnKind: "llm",
					}),
				}),
			]),
		);
	});

	it("hides scheduling and model-override capabilities for side-effect side-effect execute-only actions", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "side_effect_execute_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "legacy_plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});

		const response = await fetch(`${app.address}/api/processes/${process.id}`);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.actions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "approve_legacy",
					supportsScheduling: false,
					supportsNextTurnModelOverride: false,
					preview: expect.objectContaining({
						kind: "turn",
						turnId: "legacy_implement",
						turnKind: "llm",
					}),
				}),
			]),
		);
	});

	it("rejects scheduling for side-effect side-effect execute-only actions even when declarative scheduling metadata exists", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "side_effect_execute_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "legacy_plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});

		const response = await fetch(
			`${app.address}/api/processes/${process.id}/actions/approve_legacy`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					schedule: {
						mode: "once",
						runAt: futureIso(),
					},
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.code).toBe("action_not_schedulable");
		expect(app.ctx.deps.futureExecutions.getScheduledActionByInstance(process.id)).toBeNull();
	});

	it("returns an unavailable live model preview for side-effect side-effect execute-only actions", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "side_effect_execute_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "legacy_plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});

		const response = await fetch(
			`${app.address}/api/processes/${process.id}/actions/approve_legacy/model-preview`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input: {} }),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.preview).toMatchObject({
			kind: "unavailable",
			unavailableReason: "action_failed",
		});
	});

	it("rejects next-turn model overrides for side-effect side-effect execute-only actions", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "side_effect_execute_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "legacy_plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});

		const response = await fetch(
			`${app.address}/api/processes/${process.id}/actions/approve_legacy`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ nextTurnModelProfileId: "claude_fast" }),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.code).toBe("action_failed");
		expect(app.ctx.deps.processes.getById(process.id)?.selectedTurnId).toBe("legacy_plan_review");
	});

	it("builds live action model previews from the shared pure plan hook", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});

		const response = await fetch(
			`${app.address}/api/processes/${process.id}/actions/approve_plan/model-preview`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ input: {} }),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.preview).toMatchObject({
			kind: "llm_turn",
			turnId: "implement",
			resolvedModel: expect.objectContaining({
				status: "resolved",
				modelProfileId: "claude_fast",
			}),
		});
	});

	it("schedules plan approval actions and rejects duplicates", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});
		const firstRunAt = futureIso();
		const secondRunAt = futureIso(25 * 60);

		const firstResponse = await fetch(
			`${app.address}/api/processes/${process.id}/actions/approve_plan`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					schedule: {
						mode: "once",
						runAt: firstRunAt,
					},
				}),
			},
		);
		const firstBody = await firstResponse.json();
		expect(firstResponse.status).toBe(201);
		expect(firstBody.scheduledAction).toMatchObject({
			actionId: "approve_plan",
			action: {
				supportsScheduling: true,
				supportsNextTurnModelOverride: true,
				preview: expect.objectContaining({ turnId: "implement", turnKind: "llm" }),
			},
		});

		const secondResponse = await fetch(
			`${app.address}/api/processes/${process.id}/actions/approve_plan`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					schedule: {
						mode: "once",
						runAt: secondRunAt,
					},
				}),
			},
		);
		const secondBody = await secondResponse.json();
		expect(secondResponse.status).toBe(409);
		expect(secondBody.code).toBe("action_locked_by_schedule");
		expect(app.ctx.deps.processes.getById(process.id)?.selectedTurnId).toBe("plan_review");
	});

	it("rejects unknown schedule modes for process actions", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});

		const response = await fetch(
			`${app.address}/api/processes/${process.id}/actions/approve_plan`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					schedule: { mode: "later", runAt: futureIso() },
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.code).toBe("invalid_schedule");
		expect(app.ctx.deps.futureExecutions.getScheduledActionByInstance(process.id)).toBeNull();
		expect(app.ctx.deps.processes.getById(process.id)?.selectedTurnId).toBe("plan_review");
	});

	it("uses the stored scheduled action input when running now without resubmitting the form", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});
		const runAt = futureIso();
		const scheduledResponse = await fetch(
			`${app.address}/api/processes/${process.id}/actions/request_revision`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					input: { message: "Please expand the rollback plan." },
					schedule: { mode: "once", runAt },
				}),
			},
		);
		const scheduledBody = await scheduledResponse.json();
		expect(scheduledResponse.status).toBe(201);

		const runNowResponse = await fetch(
			`${app.address}/api/future-executions/${scheduledBody.scheduledAction.id}/action`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ schedule: { mode: "now" } }),
			},
		);
		const runNowBody = await runNowResponse.json();

		expect(runNowResponse.status).toBe(200);
		expect(runNowBody.process).toMatchObject({ selectedTurnId: "generate_plan" });
		expect(app.ctx.deps.turnAnnotations.listByInstance(process.id)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					payload: expect.objectContaining({
						actionId: "request_revision",
						submittedFields: [
							{
								fieldId: "message",
								label: "Message",
								value: "Please expand the rollback plan.",
							},
						],
					}),
				}),
			]),
		);
		expect(app.ctx.deps.futureExecutions.getById(scheduledBody.scheduledAction.id)).toBeNull();
	});

	it("keeps the existing schedule when updating a scheduled action without resubmitting schedule", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});
		const runAt = futureIso();
		const scheduledResponse = await fetch(
			`${app.address}/api/processes/${process.id}/actions/request_revision`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					input: { message: "Please expand the rollback plan." },
					schedule: { mode: "once", runAt },
				}),
			},
		);
		const scheduledBody = await scheduledResponse.json();
		expect(scheduledResponse.status).toBe(201);

		const updateResponse = await fetch(
			`${app.address}/api/future-executions/${scheduledBody.scheduledAction.id}/action`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					input: { message: "Please tighten the rollback section even more." },
				}),
			},
		);
		const updateBody = await updateResponse.json();

		expect(updateResponse.status).toBe(200);
		expect(updateBody.scheduledAction).toMatchObject({
			id: scheduledBody.scheduledAction.id,
			nextRunAt: runAt,
			actionId: "request_revision",
		});
		expect(app.ctx.deps.turnAnnotations.listByInstance(process.id)).toEqual([]);
		expect(app.ctx.deps.futureExecutions.getById(scheduledBody.scheduledAction.id)).not.toBeNull();
	});

	it("omits scheduled action details when the stored payload is invalid", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});
		const scheduled = app.ctx.deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: "{",
			nextRunAt: "2026-04-26T09:00:00.000Z",
		});

		try {
			const response = await fetch(`${app.address}/api/processes/${process.id}`);
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body.scheduledAction).toBeNull();
		} finally {
			app.ctx.deps.futureExecutions.delete(scheduled.id);
		}
	});

	it("fills scheduled action details from the current action when label metadata is omitted", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});
		const scheduled = app.ctx.deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: JSON.stringify({ input: {}, nextTurnModelProfileId: null }),
			nextRunAt: "2026-04-26T09:00:00.000Z",
		});

		try {
			const response = await fetch(`${app.address}/api/processes/${process.id}`);
			const body = await response.json();

			expect(response.status).toBe(200);
			expect(body.scheduledAction?.id).toBe(scheduled.id);
			expect(body.scheduledAction?.actionId).toBe("approve_plan");
			expect(body.scheduledAction?.actionLabel).toBe(body.scheduledAction?.action.label);
		} finally {
			app.ctx.deps.futureExecutions.delete(scheduled.id);
		}
	});

	it("keeps a scheduled action when running it now fails before commit", async () => {
		const process = app.ctx.deps.processes.create({
			processId: "generic_plan_review_process",
			lifecycleStatus: "waiting",
			selectedTurnId: "plan_review",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});
		const scheduled = app.ctx.deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: JSON.stringify({
				input: {},
				nextTurnModelProfileId: null,
				actionLabel: "Approve plan",
			}),
			nextRunAt: "2026-04-26T09:00:00.000Z",
		});
		app.ctx.deps.processes.update(process.id, {
			selectedTurnId: "implement",
			lifecycleStatus: "active",
			stateJson: JSON.stringify({
				...createEmptyStructuralProcessState(),
			}),
		});

		const response = await fetch(`${app.address}/api/future-executions/${scheduled.id}/action`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ schedule: { mode: "now" } }),
		});
		const body = await response.json();
		expect(response.status).toBe(409);
		expect(body.code).toBe("action_not_visible");
		expect(app.ctx.deps.futureExecutions.getById(scheduled.id)).not.toBeNull();
	});
});
