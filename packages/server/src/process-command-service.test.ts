import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildFailedTurnRecoveryMetadata as genericFailedTurnRecovery } from "@leitwerk-dev/domain";
import type { createServerProcessBuilder, TurnDefinition } from "@leitwerk-dev/process-sdk";
import type { WsFrame } from "@leitwerk-dev/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/config-loader.js";
import { buildProcessActionRegistry } from "./process-action-registry.js";
import { createProcessEngine } from "./process-engine/engine.js";
import { getProcessGraph } from "./process-graph.js";
import { createProcessOperationCoordinator } from "./process-operation-coordinator.js";
import { createFilesystemSessionReader } from "./process-session-store.js";
import { createFakeWorkerSupervisor as createFakeSupervisor } from "./test-helpers/fake-worker-supervisor.js";
import { defineGraphFixtureProcess } from "./test-helpers/process-binding-fixtures.js";
import { createDefaultTestProcessGraphRegistry } from "./test-helpers/process-fixtures.js";
import { prepareSuccessfulLlmTurnStarts as createSuccessfulLlmTurnStarts } from "./test-helpers/turn-start-preflight-fixtures.js";
import { createTestDeps } from "./test-helpers/unit-deps.js";

const processGraphs = createDefaultTestProcessGraphRegistry();
const ticketProcessGraph = getProcessGraph(processGraphs, "ticket_issue_process");

function createLlmTestConfig() {
	const config = getDefaultConfig();
	config.pi.model_profiles = [
		{ id: "claude_fast", provider: "fixture-provider", model_id: "fixture-model" },
	];
	return config;
}

const prepareSuccessfulLlmTurnStarts = createSuccessfulLlmTurnStarts({ profileId: "claude_fast" });

const defaultTurnDefinitions = new Map<string, TurnDefinition>([
	[
		"generate_plan",
		{
			id: "generate_plan",
			description: "Generate the candidate plan",
			kind: "llm",
			completionMode: "turn_end",
			branchType: "primary",
			context: "fresh",
			prompt: async () => "Generate a plan",
			outcomes: { plan_saved: { description: "saved", parameters: {} } },
		},
	],
	[
		"plan_review",
		{
			id: "plan_review",
			description: "Review the generated plan",
			kind: "human",
			actions: {},
		},
	],
	[
		"implement",
		{
			id: "implement",
			description: "Implement",
			kind: "llm",
			completionMode: "turn_end",
			branchType: "primary",
			context: "full",
			prompt: async () => "Implement",
			outcomes: { done: { description: "done", parameters: {} } },
		},
	],
	[
		"handoff_review",
		{
			id: "handoff_review",
			description: "Handoff review",
			kind: "automatic",
			outcomes: { created: { description: "created", parameters: {} } },
			run: async () => ({ outcome: "created", params: {} }),
		},
	],
	[
		"run_llm_review",
		{
			id: "run_llm_review",
			description: "Run review",
			kind: "llm",
			completionMode: "turn_end",
			branchType: "leaf_branch",
			context: "full",
			prompt: async () => "Review",
			outcomes: {
				issues_found: { description: "issues", parameters: {} },
				no_issues: { description: "clean", parameters: {} },
			},
		},
	],
	[
		"address_review",
		{
			id: "address_review",
			description: "Address review",
			kind: "llm",
			completionMode: "turn_end",
			branchType: "primary",
			context: "full",
			prompt: async () => "Address review",
			outcomes: { comments_addressed: { description: "done", parameters: {} } },
		},
	],
	[
		"verify_build",
		{
			id: "verify_build",
			description: "Verify build",
			kind: "llm",
			completionMode: "turn_end",
			branchType: "primary",
			context: "full",
			prompt: async () => "Verify build",
			outcomes: {
				build_failing: { description: "failing", parameters: {} },
				build_passing: { description: "passing", parameters: {} },
			},
		},
	],
	[
		"fix_build",
		{
			id: "fix_build",
			description: "Fix build",
			kind: "llm",
			completionMode: "turn_end",
			branchType: "primary",
			context: "full",
			prompt: async () => "Fix build",
			outcomes: { build_fixed: { description: "fixed", parameters: {} } },
		},
	],
	[
		"commit_and_complete",
		{
			id: "commit_and_complete",
			description: "Commit and complete",
			kind: "llm",
			completionMode: "turn_end",
			branchType: "primary",
			context: "full",
			prompt: async () => "Commit",
			outcomes: { committed: { description: "committed", parameters: {} } },
		},
	],
	[
		"implementation_review",
		{
			id: "implementation_review",
			description: "Review the implementation",
			kind: "human",
			actions: {},
		},
	],
]);

function createProcess(
	server: (api: ReturnType<typeof createServerProcessBuilder>) => void,
	options: Partial<{
		id: string;
		displayName: string;
		graph: typeof ticketProcessGraph;
		turnDefinitions: ReadonlyMap<string, TurnDefinition>;
	}> = {},
) {
	const graph = options.graph ?? ticketProcessGraph;
	const turnDefinitions = options.turnDefinitions ?? defaultTurnDefinitions;
	return defineGraphFixtureProcess({
		id: options.id ?? "ticket_issue_process",
		displayName: options.displayName ?? "Implement Ticket Issue",
		graph,
		turnDefinitions,
		paramsCodec: { parse: () => ({}), serialize: (value: unknown) => value },
		stateCodec: { parse: () => ({}), serialize: (value: unknown) => value },
		initialState: () => ({}),
		server,
	});
}

function withTurnOverrides(
	overrides: readonly (readonly [string, TurnDefinition])[],
	source: ReadonlyMap<string, TurnDefinition> = defaultTurnDefinitions,
): ReadonlyMap<string, TurnDefinition> {
	const turnDefinitions = new Map(source);
	for (const [turnId, turnDefinition] of overrides) {
		turnDefinitions.set(turnId, turnDefinition);
	}
	return turnDefinitions;
}

function createPlanReviewActionRegistry() {
	const turnDefinitions = withTurnOverrides([
		[
			"generate_plan",
			{
				id: "generate_plan",
				description: "Generate the candidate plan",
				kind: "llm" as const,
				model: "default",
				completionMode: "tool_call" as const,
				branchType: "primary" as const,
				context: "fresh" as const,
				prompt: async () => "Generate a plan",
				outcomes: {
					plan_saved: {
						description: "The candidate plan is ready for review",
						parameters: {
							summary: {
								type: "string",
								description: "Plan summary",
								required: true,
								requiredErrorCode: "summary_required",
							},
							acceptanceCriteria: {
								type: "array",
								description: "Acceptance criteria",
								items: { type: "string" },
								required: true,
								requiredErrorCode: "acceptance_criteria_required",
								minItems: 1,
								minItemsErrorCode: "acceptance_criteria_required",
							},
							planMarkdown: {
								type: "string",
								description: "Plan markdown",
								required: true,
								requiredErrorCode: "plan_markdown_required",
							},
						},
					},
				},
			},
		],
		[
			"plan_review",
			{
				id: "plan_review",
				description: "Review the generated plan",
				kind: "human" as const,
				actions: { approve_plan: { label: "Approve plan", acceptanceState: "accepted" } },
			},
		],
	]);
	return buildProcessActionRegistry({
		processes: new Map([
			[
				"ticket_issue_process",
				defineGraphFixtureProcess({
					id: "ticket_issue_process",
					displayName: "Implement Ticket Issue",
					graph: ticketProcessGraph,
					turnDefinitions,
					paramsCodec: { parse: () => ({}), serialize: (value: unknown) => value },
					stateCodec: {
						parse: (value: unknown) => (value ?? {}) as Record<string, unknown>,
						serialize: (value: unknown) => value,
					},
					initialState: () => ({}),
					server(api) {
						api.onTurnOutcome("generate_plan", async (event, ctx) => {
							if (event.outcome !== "plan_saved") {
								return;
							}
							await ctx.transition({
								turnId: "plan_review",
								lifecycleStatus: "waiting",
								state: { ...ctx.state },
							});
						});
						api.action({
							id: "approve_plan",
							label: "Approve",
							async plan(_input, ctx) {
								await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
							},
						});
					},
				}),
			],
		]),
	});
}

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-process-engine-"));
	tempRoots.push(root);
	return root;
}

async function writeInstanceTree(
	root: string,
	instanceId: string,
	entries: readonly Record<string, unknown>[],
): Promise<void> {
	await writeFile(
		path.join(root, `${instanceId}.jsonl`),
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf8",
	);
}

function treeSession() {
	return {
		type: "session",
		version: 3,
		id: "sess_1",
		timestamp: "2026-04-25T10:00:00.000Z",
		cwd: "/tmp/project",
	};
}

function treeMessage(
	id: string,
	parentId: string | null,
	content: string,
	sequence: number,
	role: "assistant" | "user" = id.startsWith("user-") ? "user" : "assistant",
) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-04-25T10:00:${String(sequence).padStart(2, "0")}.000Z`,
		message: { role, content, timestamp: sequence },
	};
}

function primaryLeafStateJson(entryId: string, turnRecordId: string) {
	return JSON.stringify({
		semanticEntryRefs: { currentPrimaryPathLeaf: { entryId, turnRecordId } },
	});
}

afterEach(async () => {
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

describe("createProcessEngine retry lifecycle effects", () => {
	it("reactivates a failed turn lineage through the lifecycle plan and starts a worker", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: { externalRef: "JRA-123" },
		});
		deps.turnRecords.create({
			id: "trn_impl_2",
			instanceId: process.id,
			turnId: "implement",
			status: "failed",
			attemptNumber: 2,
			pathType: "primary",
			forkPiEntryId: "pi_pre_impl",
		});
		const supervisor = createFakeSupervisor();
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
		});

		const result = await commands.retryProcess(process.id);

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "implement",
			lifecycleStatus: "active",
			metadata: {
				externalRef: "JRA-123",
				retryForkPiEntryId: "pi_pre_impl",
				retryFromTurnRecordId: "trn_impl_2",
			},
		});
		expect(supervisor.spawnCalls).toEqual([process.id]);
		expect(deps.events.listByInstance(process.id, 10).map((event) => event.eventType)).toContain(
			"retry_scheduled",
		);
	});

	it("restarts a lingering worker when retry reactivates a failed turn", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
		});
		deps.turnRecords.create({
			id: "trn_impl_retry_restart",
			instanceId: process.id,
			turnId: "implement",
			status: "failed",
			attemptNumber: 1,
			pathType: "primary",
			forkPiEntryId: "pi_pre_impl",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
		});

		const result = await commands.retryProcess(process.id);

		expect(result.ok).toBe(true);
		expect(supervisor.stopCalls).toEqual([
			{ instanceId: process.id, reason: "turn_changed:restart_worker" },
		]);
		expect(supervisor.spawnCalls).toEqual([process.id]);
		expect(supervisor.callLog).toEqual([
			`stop:${process.id}:turn_changed:restart_worker`,
			`spawn:${process.id}`,
		]);
	});

	it("reactivates a failed llm turn for continuation from the latest saved descendant", async () => {
		const deps = createTestDeps();
		const treeFilesDir = await createTempRoot();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: { externalRef: "JRA-789", ...genericFailedTurnRecovery("trn_impl_timeout_2") },
			stateJson: primaryLeafStateJson("primary-leaf-7", "trn_impl_7"),
		});
		await writeInstanceTree(treeFilesDir, process.id, [
			treeSession(),
			treeMessage("primary-leaf-7", null, "Primary leaf", 1),
			treeMessage("assistant-timeout-2", "primary-leaf-7", "Timed-out leaf", 2),
			treeMessage("assistant-timeout-2-latest", "assistant-timeout-2", "Latest saved progress", 3),
		]);
		deps.turnRecords.create({
			id: "trn_impl_timeout_2",
			instanceId: process.id,
			turnId: "implement",
			turnType: "llm",
			status: "failed",
			attemptNumber: 2,
			pathType: "primary",
			forkPiEntryId: "primary-leaf-7",
			resultPiEntryId: "assistant-timeout-2",
			modelProfileId: "claude_fast",
			startedAt: "2026-04-25T10:00:01.500Z",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
		});

		const result = await commands.continueFailedTurn(process.id, "trn_impl_timeout_2");

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "implement",
			lifecycleStatus: "active",
			selectedTurnModelProfileId: "claude_fast",
			metadata: {
				externalRef: "JRA-789",
				continueFromTurnRecordId: "trn_impl_timeout_2",
				continueFromPiEntryId: "assistant-timeout-2-latest",
			},
		});
		expect(supervisor.stopCalls).toEqual([
			{ instanceId: process.id, reason: "turn_changed:restart_worker" },
		]);
		expect(supervisor.spawnCalls).toEqual([process.id]);
		expect(supervisor.callLog).toEqual([
			`stop:${process.id}:turn_changed:restart_worker`,
			`spawn:${process.id}`,
		]);
		expect(deps.events.listByInstance(process.id, 10).map((event) => event.eventType)).toContain(
			"continue_scheduled",
		);
	});

	it("persists a custom continue prompt and structured recovery metadata into continuation metadata", async () => {
		const deps = createTestDeps();
		const treeFilesDir = await createTempRoot();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: {
				externalRef: "JRA-790",
				...genericFailedTurnRecovery("trn_impl_missing_markdown", {
					suggestedContinuePrompt: "Call markdown_result now with the final operator summary.",
					failureCode: "missing_markdown_result",
					missingToolNames: ["markdown_result"],
				}),
			},
			stateJson: primaryLeafStateJson("primary-leaf-custom", "trn_impl_prev_custom"),
		});
		await writeInstanceTree(treeFilesDir, process.id, [
			treeSession(),
			treeMessage("primary-leaf-custom", null, "Primary leaf", 1),
			treeMessage("assistant-timeout-custom", "primary-leaf-custom", "Timed-out leaf", 2),
		]);
		deps.turnRecords.create({
			id: "trn_impl_missing_markdown",
			instanceId: process.id,
			turnId: "implement",
			turnType: "llm",
			status: "failed",
			attemptNumber: 5,
			pathType: "primary",
			forkPiEntryId: "primary-leaf-custom",
			resultPiEntryId: "assistant-timeout-custom",
			modelProfileId: "claude_fast",
			startedAt: "2026-04-25T10:00:01.500Z",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor([process.id]),
			processGraphs,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
		});

		const result = await commands.continueFailedTurn(process.id, "trn_impl_missing_markdown", {
			prompt: "Please call markdown_result with the final operator summary.",
		});

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			metadata: {
				externalRef: "JRA-790",
				continueFromTurnRecordId: "trn_impl_missing_markdown",
				continueFromPiEntryId: "assistant-timeout-custom",
				continuePrompt: "Please call markdown_result with the final operator summary.",
			},
		});
		expect(deps.processes.getById(process.id)?.metadata).toHaveProperty(
			"failedTurnRecovery.turnRecordId",
			"trn_impl_missing_markdown",
		);
	});

	it("continues from the latest saved descendant when the failed turn never recorded a result leaf", async () => {
		const deps = createTestDeps();
		const treeFilesDir = await createTempRoot();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: genericFailedTurnRecovery("trn_impl_timeout_derived"),
			stateJson: primaryLeafStateJson("primary-leaf-derived", "trn_impl_prev"),
		});
		await writeInstanceTree(treeFilesDir, process.id, [
			treeSession(),
			treeMessage("primary-leaf-derived", null, "Primary leaf", 1),
			treeMessage("assistant-derived-1", "primary-leaf-derived", "Saved progress", 2),
		]);
		deps.turnRecords.create({
			id: "trn_impl_timeout_derived",
			instanceId: process.id,
			turnId: "implement",
			turnType: "llm",
			status: "failed",
			attemptNumber: 3,
			pathType: "primary",
			forkPiEntryId: "primary-leaf-derived",
			resultPiEntryId: null,
			modelProfileId: "claude_fast",
			startedAt: "2026-04-25T10:00:02.000Z",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
		});

		const result = await commands.continueFailedTurn(process.id, "trn_impl_timeout_derived");

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			metadata: {
				continueFromTurnRecordId: "trn_impl_timeout_derived",
				continueFromPiEntryId: "assistant-derived-1",
			},
		});
	});

	it("reopens the latest failed user continuation leaf instead of rewinding to its assistant parent", async () => {
		const deps = createTestDeps();
		const treeFilesDir = await createTempRoot();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: genericFailedTurnRecovery("trn_impl_continue_4"),
			stateJson: primaryLeafStateJson("primary-leaf-repeat", "trn_impl_prev_repeat"),
		});
		await writeInstanceTree(treeFilesDir, process.id, [
			treeSession(),
			treeMessage("primary-leaf-repeat", null, "Primary leaf", 1),
			treeMessage("assistant-timeout-repeat", "primary-leaf-repeat", "Timed-out leaf", 2),
			treeMessage("user-continue-repeat", "assistant-timeout-repeat", "continue", 3),
		]);
		deps.turnRecords.create({
			id: "trn_impl_continue_4",
			instanceId: process.id,
			turnId: "implement",
			turnType: "llm",
			status: "failed",
			attemptNumber: 4,
			pathType: "primary",
			forkPiEntryId: "primary-leaf-repeat",
			resultPiEntryId: "user-continue-repeat",
			modelProfileId: "claude_fast",
			startedAt: "2026-04-25T10:00:01.500Z",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
		});

		const result = await commands.continueFailedTurn(process.id, "trn_impl_continue_4");

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			metadata: {
				continueFromTurnRecordId: "trn_impl_continue_4",
				continueFromPiEntryId: "user-continue-repeat",
				continuePrompt: "continue",
			},
		});
	});

	it("preserves operator-added continuation instructions from the latest failed user leaf", async () => {
		const deps = createTestDeps();
		const treeFilesDir = await createTempRoot();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: genericFailedTurnRecovery("trn_impl_continue_custom_5"),
			stateJson: primaryLeafStateJson("primary-leaf-repeat-custom", "trn_impl_prev_repeat_custom"),
		});
		await writeInstanceTree(treeFilesDir, process.id, [
			treeSession(),
			treeMessage("primary-leaf-repeat-custom", null, "Primary leaf", 1),
			treeMessage(
				"assistant-timeout-repeat-custom",
				"primary-leaf-repeat-custom",
				"Timed-out leaf",
				2,
			),
			treeMessage(
				"user-continue-repeat-custom",
				"assistant-timeout-repeat-custom",
				"Continue from this exact branch and keep the previous tool choice.",
				3,
			),
		]);
		deps.turnRecords.create({
			id: "trn_impl_continue_custom_5",
			instanceId: process.id,
			turnId: "implement",
			turnType: "llm",
			status: "failed",
			attemptNumber: 5,
			pathType: "primary",
			forkPiEntryId: "primary-leaf-repeat-custom",
			resultPiEntryId: "user-continue-repeat-custom",
			modelProfileId: "claude_fast",
			startedAt: "2026-04-25T10:00:01.500Z",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor([process.id]),
			processGraphs,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
		});

		const result = await commands.continueFailedTurn(process.id, "trn_impl_continue_custom_5");

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			metadata: {
				continueFromTurnRecordId: "trn_impl_continue_custom_5",
				continueFromPiEntryId: "user-continue-repeat-custom",
				continuePrompt: "Continue from this exact branch and keep the previous tool choice.",
			},
		});
	});

	it("allows primary-turn continuation when the failed branch leaf exists even if currentPrimaryPathLeaf is stale", async () => {
		const deps = createTestDeps();
		const treeFilesDir = await createTempRoot();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: genericFailedTurnRecovery("trn_impl_timeout_stale_primary"),
			stateJson: primaryLeafStateJson("stale-primary-leaf", "trn_impl_stale_primary"),
		});
		await writeInstanceTree(treeFilesDir, process.id, [
			treeSession(),
			treeMessage("primary-leaf-live", null, "Primary leaf", 1),
			treeMessage("assistant-timeout-live", "primary-leaf-live", "Timed-out leaf", 2),
		]);
		deps.turnRecords.create({
			id: "trn_impl_timeout_stale_primary",
			instanceId: process.id,
			turnId: "implement",
			turnType: "llm",
			status: "failed",
			attemptNumber: 6,
			pathType: "primary",
			forkPiEntryId: "primary-leaf-live",
			resultPiEntryId: "assistant-timeout-live",
			modelProfileId: "claude_fast",
			startedAt: "2026-04-25T10:00:01.500Z",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor([process.id]),
			processGraphs,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
		});

		const result = await commands.continueFailedTurn(process.id, "trn_impl_timeout_stale_primary");

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			lifecycleStatus: "active",
			metadata: {
				continueFromTurnRecordId: "trn_impl_timeout_stale_primary",
				continueFromPiEntryId: "assistant-timeout-live",
			},
		});
	});

	it("rejects continuation before reactivating the process when the saved progress is missing", async () => {
		const deps = createTestDeps();
		const treeFilesDir = await createTempRoot();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: { externalRef: "JRA-999", ...genericFailedTurnRecovery("trn_impl_timeout_3") },
			stateJson: primaryLeafStateJson("primary-leaf-9", "trn_impl_9"),
		});
		await writeInstanceTree(treeFilesDir, process.id, [
			treeSession(),
			treeMessage("primary-leaf-9", null, "Primary leaf", 1),
		]);
		deps.turnRecords.create({
			id: "trn_impl_timeout_3",
			instanceId: process.id,
			turnId: "implement",
			turnType: "llm",
			status: "failed",
			attemptNumber: 3,
			pathType: "primary",
			forkPiEntryId: "primary-leaf-9",
			resultPiEntryId: "assistant-timeout-3",
			modelProfileId: "claude_fast",
			startedAt: "2026-04-25T10:00:01.500Z",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
		});

		const result = await commands.continueFailedTurn(process.id, "trn_impl_timeout_3");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid_transition");
		expect(result.message).toMatch(/saved progress/i);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: { externalRef: "JRA-999" },
		});
		expect(supervisor.stopCalls).toEqual([]);
		expect(supervisor.spawnCalls).toEqual([]);
		expect(
			deps.events.listByInstance(process.id, 10).map((event) => event.eventType),
		).not.toContain("continue_scheduled");
	});

	it("rejects continuation when the failed turn has no saved progress", async () => {
		const deps = createTestDeps();
		const treeFilesDir = await createTempRoot();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
			metadata: genericFailedTurnRecovery("trn_impl_failed_no_leaf"),
		});
		await writeInstanceTree(treeFilesDir, process.id, [
			treeSession(),
			treeMessage("root-leaf", null, "Primary leaf", 1),
		]);
		deps.turnRecords.create({
			id: "trn_impl_failed_no_leaf",
			instanceId: process.id,
			turnId: "implement",
			turnType: "llm",
			status: "failed",
			attemptNumber: 1,
			pathType: "primary",
			forkPiEntryId: "root-leaf",
			resultPiEntryId: null,
			startedAt: "2026-04-25T10:00:02.000Z",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor(),
			processGraphs,
			sessionReader: createFilesystemSessionReader(treeFilesDir),
		});

		const result = await commands.continueFailedTurn(process.id, "trn_impl_failed_no_leaf");

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid_transition");
		expect(result.message).toMatch(/saved progress/i);
	});

	it("parks the process and stops the failed worker when a running turn crashes", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});
		deps.turnRecords.create({
			id: "trn_impl_1",
			instanceId: process.id,
			turnId: "implement",
			status: "running",
			attemptNumber: 1,
			pathType: "primary",
			forkPiEntryId: "pi_pre_impl",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
		});

		const result = await commands.recordWorkerFailure(process.id, {
			errorCode: "process_exited",
			message: "Worker exited unexpectedly",
			errorClass: "infrastructure",
		});

		expect(result.ok).toBe(true);
		expect(deps.turnRecords.getById("trn_impl_1")).toMatchObject({
			status: "failed",
			errorClass: "infrastructure",
		});
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "implement",
			lifecycleStatus: "error",
		});
		expect(supervisor.stopCalls).toEqual([
			{ instanceId: process.id, reason: "worker_failed:process_exited" },
		]);
		expect(supervisor.spawnCalls).toEqual([]);
		expect(supervisor.callLog).toEqual([`stop:${process.id}:worker_failed:process_exited`]);
	});

	it("ignores duplicate worker failures once the process is already parked", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "error",
		});
		deps.turnRecords.create({
			id: "trn_impl_failed_1",
			instanceId: process.id,
			turnId: "implement",
			status: "failed",
			attemptNumber: 1,
			pathType: "primary",
			forkPiEntryId: "pi_pre_impl",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
		});

		const result = await commands.recordWorkerFailure(process.id, {
			errorCode: "process_exited",
			message: "Duplicate worker failure",
			errorClass: "infrastructure",
		});

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			lifecycleStatus: "error",
		});
		expect(supervisor.stopCalls).toEqual([]);
		expect(supervisor.spawnCalls).toEqual([]);
		expect(supervisor.callLog).toEqual([]);
	});
});

describe("createProcessEngine queued input lifecycle effects", () => {
	it("queues inputs through the lifecycle applier and returns the persisted inputs", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "generate_plan",
			lifecycleStatus: "active",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor(),
			processGraphs,
		});

		const result = await commands.queueInputs(process.id, [
			{ source: "app_steer", kind: "instruction", bodyMarkdown: "Please revise" },
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data).toHaveLength(1);
		expect(result.data[0]).toMatchObject({
			instanceId: process.id,
			source: "app_steer",
			kind: "instruction",
			bodyMarkdown: "Please revise",
		});
		expect(deps.inputs.listByInstance(process.id)).toHaveLength(1);
	});

	it("persists queued input targets when provided", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "run_llm_review",
			lifecycleStatus: "active",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor(),
			processGraphs,
		});

		const result = await commands.queueInputs(process.id, [
			{
				source: "action_prompt",
				kind: "instruction",
				target: { semanticRef: "review" },
				bodyMarkdown: "Make the review more concrete.",
			},
		]);

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.data[0]).toMatchObject({
			target: { semanticRef: "review" },
			bodyMarkdown: "Make the review more concrete.",
		});
	});

	it("rejects targeted queued inputs whose kind is not instruction", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "run_llm_review",
			lifecycleStatus: "active",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor(),
			processGraphs,
		});

		const result = await commands.queueInputs(process.id, [
			{
				source: "action_prompt",
				kind: "system_event",
				target: { semanticRef: "review" },
				bodyMarkdown: "invalid",
			},
		]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid_process_input");
		expect(result.message).toContain("requires kind 'instruction'");
	});

	it("rejects targeted queued inputs with blank bodyMarkdown", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "run_llm_review",
			lifecycleStatus: "active",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor(),
			processGraphs,
		});

		const result = await commands.queueInputs(process.id, [
			{
				source: "action_prompt",
				kind: "instruction",
				target: { semanticRef: "review" },
				bodyMarkdown: "   ",
			},
		]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("invalid_process_input");
		expect(result.message).toContain("requires a non-empty bodyMarkdown");
	});

	it("rejects queued inputs while a scheduled action is pending", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "review_plan",
			lifecycleStatus: "waiting",
		});
		deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: JSON.stringify({ input: {}, actionLabel: "Approve plan" }),
			nextRunAt: "2026-04-25T09:00:00.000Z",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor(),
			processGraphs,
		});

		const result = await commands.queueInputs(process.id, [
			{ source: "app_steer", kind: "instruction", bodyMarkdown: "Please revise" },
		]);

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("scheduled_action_locked");
		expect(result.message).toMatch(/locked until the scheduled action runs/i);
	});
});

describe("createProcessEngine external action dispatch", () => {
	it("ignores external actions that are not exposed by the current turn", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "commit_and_complete",
			lifecycleStatus: "active",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const registry = buildProcessActionRegistry({
			processes: new Map([["ticket_issue_process", createProcess(() => {})]]),
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			getProcessActionRegistry: () => registry,
		});

		const result = await commands.dispatchExternalTurnTrigger(process.id, "metadata_synced", {
			projectId: "prj_test",
		});

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: "commit_and_complete",
			lifecycleStatus: "active",
		});
		expect(supervisor.stopCalls).toEqual([]);
		expect(supervisor.spawnCalls).toEqual([]);
	});
});

describe("createProcessEngine process transition effects", () => {
	it("records human-turn lineage and acceptance annotations for review actions", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({}),
		});
		deps.turnRecords.create({
			id: "trn_plan_source",
			instanceId: process.id,
			turnId: "generate_plan",
			turnType: "llm",
			status: "succeeded",
			attemptNumber: 1,
			pathType: "primary",
			resultPiEntryId: "assistant-plan",
		});
		const supervisor = createFakeSupervisor();
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					createProcess(
						(api) => {
							api.action({
								id: "approve_plan",
								label: "Approve",
								async plan(_input, ctx) {
									await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
								},
							});
						},
						{
							turnDefinitions: withTurnOverrides([
								[
									"plan_review",
									{
										id: "plan_review",
										description: "Review the generated plan",
										kind: "human",
										reviewSemanticRef: "plan",
										actions: {
											approve_plan: { label: "Approve plan", acceptanceState: "accepted" },
											request_revision: {
												label: "Request revision",
												acceptanceState: "requires_changes",
											},
										},
									},
								],
							]),
						},
					),
				],
			]),
		});
		const commands = createProcessEngine({
			...deps,
			config: createLlmTestConfig(),
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			getProcessActionRegistry: () => registry,
			prepareTurnStarts: prepareSuccessfulLlmTurnStarts,
		});

		const result = await commands.executeProcessAction(process.id, "approve_plan", {});

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)?.selectedTurnId).toBe("implement");
		expect(supervisor.spawnCalls).toEqual([process.id]);

		const humanTurnRecords = deps.turnRecords
			.listByInstance(process.id)
			.filter((turnRecord) => turnRecord.turnType === "human");
		expect(humanTurnRecords).toHaveLength(1);
		expect(humanTurnRecords[0]).toMatchObject({
			turnId: "plan_review",
			turnType: "human",
			status: "succeeded",
			pathType: "primary",
			forkPiEntryId: null,
			resultPiEntryId: null,
		});

		const annotations = deps.turnAnnotations.listByInstance(process.id);
		expect(annotations).toHaveLength(1);
		expect(annotations[0]).toMatchObject({
			annotationType: "acceptance_state",
			payload: {
				turnId: "plan_review",
				actionId: "approve_plan",
				actionLabel: "Approve plan",
				acceptanceState: "accepted",
				selectedTurnIdBefore: "plan_review",
				selectedTurnIdAfter: "implement",
				causedSelectedTurnId: "implement",
				causedSelectedTurnType: "llm",
				sourceTurnRecordId: "trn_plan_source",
			},
		});
		expect(annotations[0]?.references).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "turn_record",
					turnRecordId: humanTurnRecords[0]?.id,
				}),
				expect.objectContaining({ kind: "semantic_entry_ref", ref: "plan" }),
			]),
		);
	});

	it("persists submitted human-review form fields in acceptance annotations", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({}),
		});
		const supervisor = createFakeSupervisor();
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					createProcess(
						(api) => {
							api.action({
								id: "request_revision",
								label: "Request revision",
								form: {
									id: "request_revision_form",
									title: "Request revision",
									fields: [
										{
											id: "message",
											label: "Revision request",
											kind: "textarea",
											required: true,
										},
									],
								},
								async plan(input, ctx) {
									const message = typeof input.message === "string" ? input.message.trim() : "";
									if (!message) {
										throw new Error("message is required");
									}
									await ctx.transition({ turnId: "generate_plan", trigger: "revision_requested" });
								},
							});
						},
						{
							turnDefinitions: withTurnOverrides([
								[
									"plan_review",
									{
										id: "plan_review",
										description: "Review the generated plan",
										kind: "human",
										reviewSemanticRef: "plan",
										actions: {
											request_revision: {
												label: "Request revision",
												acceptanceState: "requires_changes",
											},
										},
									},
								],
							]),
						},
					),
				],
			]),
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			getProcessActionRegistry: () => registry,
		});

		const result = await commands.executeProcessAction(process.id, "request_revision", {
			message: "Tighten the plan and call out rollout risks.",
		});

		expect(result.ok).toBe(true);
		const annotations = deps.turnAnnotations.listByInstance(process.id);
		expect(annotations).toHaveLength(1);
		expect(annotations[0]).toMatchObject({
			annotationType: "acceptance_state",
			payload: expect.objectContaining({
				actionId: "request_revision",
				actionLabel: "Request revision",
				acceptanceState: "requires_changes",
				submittedFields: [
					{
						fieldId: "message",
						label: "Revision request",
						value: "Tighten the plan and call out rollout risks.",
					},
				],
			}),
		});
	});

	it("records external-triggered actions as external turns", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "poem_creator_process",
			selectedTurnId: "poem_review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({}),
		});
		const supervisor = createFakeSupervisor();
		const poemCreatorTurns = new Map([
			["draft_poem", { turnType: "llm" as const }],
			["poem_review", { turnType: "human" as const }],
		]);
		const poemCreatorProcess = createProcess(
			(api) => {
				api.action({
					id: "request_poem_revision",
					label: "Request revision",
					form: {
						id: "request_poem_revision_form",
						title: "Request revision",
						fields: [
							{ id: "message", label: "Revision request", kind: "textarea", required: true },
						],
					},
					async plan(_input, ctx) {
						await ctx.transition({ turnId: "draft_poem", trigger: "revision_requested" });
					},
				});
			},
			{
				id: "poem_creator_process",
				displayName: "Poem Creator",
				graph: {
					id: "poem_creator_process",
					entryTurnIds: new Set(["draft_poem"]),
					turns: poemCreatorTurns,
				} as typeof ticketProcessGraph,
				turnDefinitions: new Map([
					[
						"draft_poem",
						{
							id: "draft_poem",
							description: "Draft poem",
							kind: "llm",
							completionMode: "turn_end",
							branchType: "primary",
							context: "fresh",
							prompt: async () => "Draft poem",
							outcomes: { completed: { description: "done", parameters: {} } },
						},
					],
					[
						"poem_review",
						{
							id: "poem_review",
							description: "Review the poem",
							kind: "human",
							actions: {
								request_poem_revision: {
									label: "Request revision",
									acceptanceState: "requires_changes",
									externalTriggers: [
										{
											id: "poem_review_file",
											label: "Configured poem review file",
											description: "Write revision feedback to the poem review trigger file.",
										},
									],
									trigger: "revision_requested",
									to: "draft_poem",
								},
							},
						},
					],
				]),
			},
		);
		const registry = buildProcessActionRegistry({
			processes: new Map([["poem_creator_process", poemCreatorProcess]]),
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs: new Map([["poem_creator_process", poemCreatorProcess]]),
			getProcessActionRegistry: () => registry,
		});

		const result = await commands.executeProcessAction(
			process.id,
			"request_poem_revision",
			{ message: "Please add more twilight imagery." },
			{ source: "external" },
		);

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)?.selectedTurnId).toBe("draft_poem");
		const externalTurnRecords = deps.turnRecords
			.listByInstance(process.id)
			.filter((turnRecord) => turnRecord.turnType === "external");
		expect(externalTurnRecords).toHaveLength(1);
		expect(externalTurnRecords[0]).toMatchObject({
			turnId: "poem_review",
			turnType: "external",
			status: "succeeded",
		});
		const annotations = deps.turnAnnotations.listByInstance(process.id);
		expect(annotations).toHaveLength(1);
		expect(annotations[0]).toMatchObject({
			annotationType: "external_trigger",
			payload: expect.objectContaining({
				actionId: "request_poem_revision",
				actionLabel: "Request revision",
				acceptanceState: "requires_changes",
				actionSource: "external",
				actionOrigin: "external_interface",
				selectedTurnIdBefore: "poem_review",
				selectedTurnIdAfter: "draft_poem",
				causedSelectedTurnId: "draft_poem",
				causedSelectedTurnType: "llm",
				triggerId: "poem_review_file",
				triggerLabel: "Configured poem review file",
				submittedFields: [
					{
						fieldId: "message",
						label: "Revision request",
						value: "Please add more twilight imagery.",
					},
				],
			}),
		});
	});

	it("restarts the worker when an active selected turn changes", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "handoff_review",
			lifecycleStatus: "active",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					createProcess((api) => {
						api.action({
							id: "handoff_review",
							label: "Handoff review",
							async plan(_input, ctx) {
								await ctx.transition({
									turnId: "run_llm_review",
									state: {},
								});
							},
						});
					}),
				],
			]),
		});
		const commands = createProcessEngine({
			...deps,
			config: createLlmTestConfig(),
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			getProcessActionRegistry: () => registry,
			prepareTurnStarts: prepareSuccessfulLlmTurnStarts,
		});

		const result = await commands.executeProcessAction(process.id, "handoff_review", {});

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)?.selectedTurnId).toBe("run_llm_review");
		expect(supervisor.callLog).toEqual([
			`stop:${process.id}:turn_changed:restart_worker`,
			`spawn:${process.id}`,
		]);
	});

	it("reports post-commit stage when action worker reconciliation fails after commit", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "handoff_review",
			lifecycleStatus: "active",
		});
		const supervisor = createFakeSupervisor([process.id], {
			stopWorker() {
				throw new Error("worker stop failed");
			},
		});
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					createProcess((api) => {
						api.action({
							id: "handoff_review",
							label: "Handoff review",
							async plan(_input, ctx) {
								await ctx.transition({
									turnId: "run_llm_review",
									state: {},
								});
							},
						});
					}),
				],
			]),
		});
		const commands = createProcessEngine({
			...deps,
			config: createLlmTestConfig(),
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			getProcessActionRegistry: () => registry,
			prepareTurnStarts: prepareSuccessfulLlmTurnStarts,
		});

		const result = await commands.executeProcessAction(process.id, "handoff_review", {});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.stage).toBe("post_commit");
		expect(result.code).toBe("worker_reconcile_failed");
		expect(result.process).toMatchObject({
			selectedTurnId: "run_llm_review",
			lifecycleStatus: "active",
		});
	});

	it("spawns a worker when an active selected turn changes and no worker is running", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "handoff_review",
			lifecycleStatus: "active",
		});
		const supervisor = createFakeSupervisor();
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					createProcess((api) => {
						api.action({
							id: "handoff_review",
							label: "Handoff review",
							async plan(_input, ctx) {
								await ctx.transition({
									turnId: "run_llm_review",
									state: {},
								});
							},
						});
					}),
				],
			]),
		});
		const commands = createProcessEngine({
			...deps,
			config: createLlmTestConfig(),
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			getProcessActionRegistry: () => registry,
			prepareTurnStarts: prepareSuccessfulLlmTurnStarts,
		});

		const result = await commands.executeProcessAction(process.id, "handoff_review", {});

		expect(result.ok).toBe(true);
		expect(result.process?.selectedTurnId).toBe("run_llm_review");
		expect(supervisor.spawnCalls).toEqual([process.id]);
	});

	it("rejects next-turn model overrides for execute-only actions", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({}),
		});
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					createProcess((api) => {
						api.action({
							id: "approve_plan",
							label: "Approve plan",
							executionMode: "side_effect",
							async execute(_input, ctx) {
								await ctx.transition({
									turnId: "implement",
									trigger: "plan_approved",
									state: {},
								});
							},
						});
					}),
				],
			]),
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor(),
			processGraphs,
			getProcessActionRegistry: () => registry,
		});

		const result = await commands.executeProcessAction(
			process.id,
			"approve_plan",
			{},
			{
				nextTurnModelProfileId: "claude_fast",
			},
		);

		expect(result).toMatchObject({
			ok: false,
			stage: "pre_commit",
			code: "action_failed",
		});
		expect(result.error).toContain("declare plan(...)");
		expect(deps.processes.getById(process.id)?.selectedTurnId).toBe("plan_review");
	});

	it("restarts the worker when the transition requires a fresh session", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "handoff_review",
			lifecycleStatus: "active",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					createProcess((api) => {
						api.action({
							id: "restart_review",
							label: "Restart review",
							async plan(_input, ctx) {
								await ctx.transition({
									turnId: "run_llm_review",
									state: {},
									effect: { runtime: "restart_worker" },
								});
							},
						});
					}),
				],
			]),
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			getProcessActionRegistry: () => registry,
		});

		const result = await commands.executeProcessAction(process.id, "restart_review", {});

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)?.selectedTurnId).toBe("run_llm_review");
		expect(supervisor.stopCalls).toEqual([
			{ instanceId: process.id, reason: "turn_changed:restart_worker" },
		]);
		expect(supervisor.spawnCalls).toEqual([process.id]);
	});
});

describe("createProcessEngine future action cleanup", () => {
	it("cancels scheduled actions when a process is aborted", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "review_plan",
			lifecycleStatus: "waiting",
		});
		deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: JSON.stringify({ input: {}, actionLabel: "Approve plan" }),
			nextRunAt: "2026-04-25T09:00:00.000Z",
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => createFakeSupervisor(),
			processGraphs,
		});

		const result = await commands.abortProcess(process.id);

		expect(result.ok).toBe(true);
		expect(deps.futureExecutions.getScheduledActionByInstance(process.id)).toBeNull();
	});

	it("still cancels scheduled actions when abort commits but worker shutdown fails", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "review_plan",
			lifecycleStatus: "waiting",
		});
		deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: JSON.stringify({ input: {}, actionLabel: "Approve plan" }),
			nextRunAt: "2026-04-25T09:00:00.000Z",
		});
		const supervisor = createFakeSupervisor([process.id], {
			stopWorker() {
				throw new Error("worker shutdown failed");
			},
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
		});

		const result = await commands.abortProcess(process.id);

		expect(result.ok).toBe(false);
		expect(result.process).toMatchObject({
			selectedTurnId: null,
			lifecycleStatus: "aborted",
		});
		expect(deps.futureExecutions.getScheduledActionByInstance(process.id)).toBeNull();
	});

	it("supersedes the active running turn when a process is aborted", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "implement",
			lifecycleStatus: "active",
		});
		deps.turnRecords.create({
			id: "trn_impl_active",
			instanceId: process.id,
			turnId: "implement",
			status: "running",
			attemptNumber: 1,
			pathType: "primary",
			forkPiEntryId: "pi_pre_impl",
		});
		const supervisor = createFakeSupervisor([process.id]);
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
		});

		const result = await commands.abortProcess(process.id);

		expect(result.ok).toBe(true);
		expect(deps.processes.getById(process.id)).toMatchObject({
			selectedTurnId: null,
			lifecycleStatus: "aborted",
		});
		expect(deps.turnRecords.getById("trn_impl_active")).toMatchObject({
			status: "superseded",
			endedAt: expect.any(String),
		});
		expect(supervisor.stopCalls).toEqual([
			{ instanceId: process.id, reason: "turn_changed:aborted" },
		]);
	});

	it("allows and consumes the current scheduled action inside the action command", async () => {
		const deps = createTestDeps();
		const process = deps.processes.create({
			processId: "ticket_issue_process",
			selectedTurnId: "plan_review",
			lifecycleStatus: "waiting",
			stateJson: JSON.stringify({}),
		});
		const scheduledAction = deps.futureExecutions.create({
			kind: "action",
			scheduleKind: "once",
			processId: process.processId,
			instanceId: process.id,
			actionId: "approve_plan",
			payloadJson: JSON.stringify({ input: {}, actionLabel: "Approve plan" }),
			nextRunAt: "2026-04-25T09:00:00.000Z",
		});
		const supervisor = createFakeSupervisor();
		const registry = buildProcessActionRegistry({
			processes: new Map([
				[
					"ticket_issue_process",
					createProcess(
						(api) => {
							api.action({
								id: "approve_plan",
								label: "Approve",
								async plan(_input, ctx) {
									await ctx.transition({ turnId: "implement", trigger: "plan_approved" });
								},
							});
						},
						{
							turnDefinitions: withTurnOverrides([
								[
									"plan_review",
									{
										id: "plan_review",
										description: "Review the generated plan",
										kind: "human",
										reviewSemanticRef: "plan",
										actions: {
											approve_plan: { label: "Approve plan", acceptanceState: "accepted" },
										},
									},
								],
							]),
						},
					),
				],
			]),
		});
		const commands = createProcessEngine({
			...deps,
			processOperations: createProcessOperationCoordinator(),
			getSupervisor: () => supervisor,
			processGraphs,
			getProcessActionRegistry: () => registry,
		});

		const result = await commands.executeProcessAction(
			process.id,
			"approve_plan",
			{},
			{
				scheduledExecutionId: scheduledAction.id,
				consumeScheduledExecutionOnSuccess: true,
			},
		);

		expect(result.ok).toBe(true);
		expect(deps.futureExecutions.getById(scheduledAction.id)).toBeNull();
	});

	describe("attention toasts", () => {
		it("emits an action-required toast after a scheduled action lock is consumed", async () => {
			const deps = createTestDeps();
			const frames: WsFrame[] = [];
			const process = deps.processes.create({
				processId: "ticket_issue_process",
				selectedTurnId: "plan_review",
				lifecycleStatus: "waiting",
				title: "PROJ-125",
				stateJson: JSON.stringify({}),
			});
			const scheduledAction = deps.futureExecutions.create({
				kind: "action",
				scheduleKind: "once",
				processId: process.processId,
				instanceId: process.id,
				actionId: "send_to_implementation_review",
				payloadJson: JSON.stringify({ input: {}, actionLabel: "Send to implementation review" }),
				nextRunAt: "2026-04-25T09:00:00.000Z",
			});
			const scheduledProcessDefinition = createProcess(
				(api) => {
					api.action({
						id: "send_to_implementation_review",
						label: "Send to implementation review",
						async plan(_input, ctx) {
							await ctx.transition({
								turnId: "implementation_review",
								trigger: "scheduled_review",
								state: { ...ctx.state },
							});
						},
					});
					api.action({
						id: "accept_implementation",
						label: "Accept implementation",
						async plan(_input, ctx) {
							await ctx.transition({ lifecycleStatus: "completed", turnId: null });
						},
					});
				},
				{
					turnDefinitions: withTurnOverrides([
						[
							"plan_review",
							{
								id: "plan_review",
								description: "Review the generated plan",
								kind: "human",
								actions: {
									send_to_implementation_review: {
										label: "Send to implementation review",
										acceptanceState: "accepted",
										trigger: "scheduled_review",
										to: "implementation_review",
									},
								},
							},
						],
						[
							"implementation_review",
							{
								id: "implementation_review",
								description: "Review the implementation",
								kind: "human",
								actions: {
									accept_implementation: {
										label: "Accept implementation",
										acceptanceState: "accepted",
									},
								},
							},
						],
					]),
				},
			);
			const localProcessGraphs = new Map([["ticket_issue_process", scheduledProcessDefinition]]);
			const registry = buildProcessActionRegistry({ processes: localProcessGraphs });
			const commands = createProcessEngine({
				...deps,
				toastTtlMs: 1234,
				processOperations: createProcessOperationCoordinator(),
				getSupervisor: () => undefined,
				processGraphs: localProcessGraphs,
				getProcessActionRegistry: () => registry,
			});
			const broadcast = deps.broadcaster.broadcast.bind(deps.broadcaster);
			deps.broadcaster.broadcast = (frame) => {
				frames.push(frame);
				broadcast(frame);
			};

			const result = await commands.executeProcessAction(
				process.id,
				"send_to_implementation_review",
				{},
				{
					source: "scheduled",
					scheduledExecutionId: scheduledAction.id,
					consumeScheduledExecutionOnSuccess: true,
				},
			);

			expect(result.ok).toBe(true);
			expect(deps.futureExecutions.getById(scheduledAction.id)).toBeNull();
			expect(deps.processes.getById(process.id)).toMatchObject({
				selectedTurnId: "implementation_review",
				lifecycleStatus: "waiting",
			});
			expect(frames).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "future.updated",
						payload: expect.objectContaining({
							futureExecutionId: scheduledAction.id,
							operation: "deleted",
						}),
					}),
					expect.objectContaining({
						type: "process.toast",
						instanceId: process.id,
						payload: expect.objectContaining({
							eventType: "action_required",
							level: "warn",
						}),
					}),
				]),
			);
		});

		it("emits an action-required toast when a turn outcome parks the process at a visible decision", async () => {
			const deps = createTestDeps();
			const frames: WsFrame[] = [];
			const process = deps.processes.create({
				processId: "ticket_issue_process",
				selectedTurnId: "generate_plan",
				lifecycleStatus: "active",
				title: "PROJ-123",
			});
			deps.turnRecords.create({
				id: "trn_plan_1",
				instanceId: process.id,
				turnId: "generate_plan",
				turnType: "llm",
				status: "running",
				pathType: "primary",
				startedAt: "2026-04-30T12:00:00.000Z",
			});
			const registry = createPlanReviewActionRegistry();
			const commands = createProcessEngine({
				...deps,
				toastTtlMs: 1234,
				processOperations: createProcessOperationCoordinator(),
				getSupervisor: () => undefined,
				processGraphs,
				getProcessActionRegistry: () => registry,
			});
			const broadcast = deps.broadcaster.broadcast.bind(deps.broadcaster);
			deps.broadcaster.broadcast = (frame) => {
				frames.push(frame);
				broadcast(frame);
			};

			const result = await commands.recordTurnOutcome(process.id, {
				instanceId: process.id,
				turnRecordId: "trn_plan_1",
				turnId: "generate_plan",
				turnType: "llm",
				outcome: "plan_saved",
				pathType: "primary",
				resultPiEntryId: "assistant-plan",
				rootEntryId: "root-user",
				turnResultMarkdown: "## Plan",
				params: {
					summary: "Initial plan",
					acceptanceCriteria: ["A"],
					planMarkdown: "## Plan",
				},
			});

			expect(result.ok).toBe(true);
			expect(frames).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "process.toast",
						instanceId: process.id,
						payload: expect.objectContaining({
							eventType: "action_required",
							level: "warn",
							message: "PROJ-123 · Review the generated plan needs a decision",
							ttlMs: 1234,
						}),
					}),
				]),
			);
		});

		it("still emits an action-required toast when the waiting transition committed before post-commit stop failed", async () => {
			const deps = createTestDeps();
			const frames: WsFrame[] = [];
			const process = deps.processes.create({
				processId: "ticket_issue_process",
				selectedTurnId: "generate_plan",
				lifecycleStatus: "active",
				title: "PROJ-124",
			});
			deps.turnRecords.create({
				id: "trn_plan_1",
				instanceId: process.id,
				turnId: "generate_plan",
				turnType: "llm",
				status: "running",
				pathType: "primary",
				startedAt: "2026-04-30T12:00:00.000Z",
			});
			const registry = createPlanReviewActionRegistry();
			const supervisor = createFakeSupervisor([process.id], {
				async stopWorker() {
					throw new Error("stop exploded");
				},
			});
			const commands = createProcessEngine({
				...deps,
				toastTtlMs: 1234,
				processOperations: createProcessOperationCoordinator(),
				getSupervisor: () => supervisor,
				processGraphs,
				getProcessActionRegistry: () => registry,
			});
			const broadcast = deps.broadcaster.broadcast.bind(deps.broadcaster);
			deps.broadcaster.broadcast = (frame) => {
				frames.push(frame);
				broadcast(frame);
			};

			const result = await commands.recordTurnOutcome(process.id, {
				instanceId: process.id,
				turnRecordId: "trn_plan_1",
				turnId: "generate_plan",
				turnType: "llm",
				outcome: "plan_saved",
				pathType: "primary",
				resultPiEntryId: "assistant-plan",
				rootEntryId: "root-user",
				turnResultMarkdown: "## Plan",
				params: {
					summary: "Initial plan",
					acceptanceCriteria: ["A"],
					planMarkdown: "## Plan",
				},
			});

			expect(result.ok).toBe(false);
			expect(result.code).toBe("worker_reconcile_failed");
			expect(result.process).toMatchObject({
				selectedTurnId: "plan_review",
				lifecycleStatus: "waiting",
			});
			expect(frames).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "process.toast",
						instanceId: process.id,
						payload: expect.objectContaining({
							eventType: "action_required",
							level: "warn",
							message: "PROJ-124 · Review the generated plan needs a decision",
							ttlMs: 1234,
						}),
					}),
				]),
			);
		});

		it("emits an error-recovery toast after lifecycle parking leaves the process in error", async () => {
			const deps = createTestDeps();
			const frames: WsFrame[] = [];
			const process = deps.processes.create({
				processId: "ticket_issue_process",
				selectedTurnId: "implement",
				lifecycleStatus: "active",
				title: "PROJ-456",
			});
			deps.turnRecords.create({
				id: "trn_impl_1",
				instanceId: process.id,
				turnId: "implement",
				turnType: "llm",
				status: "running",
				pathType: "primary",
				startedAt: "2026-04-30T12:00:00.000Z",
			});
			const commands = createProcessEngine({
				...deps,
				toastTtlMs: 1234,
				processOperations: createProcessOperationCoordinator(),
				getSupervisor: () => undefined,
				processGraphs,
			});
			const broadcast = deps.broadcaster.broadcast.bind(deps.broadcaster);
			deps.broadcaster.broadcast = (frame) => {
				frames.push(frame);
				broadcast(frame);
			};

			await commands.recordTurnFailed(process.id, {
				instanceId: process.id,
				turnRecordId: "trn_impl_1",
				turnId: "implement",
				turnType: "llm",
				pathType: "primary",
				errorSummary: "LLM timeout",
				errorClass: "llm_error",
			});
			frames.length = 0;

			const result = await commands.parkProcessLifecycle(process.id, {
				selectedTurnId: "implement",
				reason: "LLM timeout",
				errorClass: "llm_error",
			});

			expect(result.ok).toBe(true);
			expect(frames).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "process.toast",
						instanceId: process.id,
						payload: expect.objectContaining({
							eventType: "turn_failed",
							level: "error",
							ttlMs: 1234,
						}),
					}),
				]),
			);
		});

		it("still emits a worker-failure toast when the error state committed before post-commit stop failed", async () => {
			const deps = createTestDeps();
			const frames: WsFrame[] = [];
			const process = deps.processes.create({
				processId: "ticket_issue_process",
				selectedTurnId: "generate_plan",
				lifecycleStatus: "active",
				title: "PROJ-457",
			});
			const registry = createPlanReviewActionRegistry();
			const supervisor = createFakeSupervisor([process.id], {
				async stopWorker() {
					throw new Error("stop exploded");
				},
			});
			const commands = createProcessEngine({
				...deps,
				toastTtlMs: 1234,
				processOperations: createProcessOperationCoordinator(),
				getSupervisor: () => supervisor,
				processGraphs,
				getProcessActionRegistry: () => registry,
			});
			const broadcast = deps.broadcaster.broadcast.bind(deps.broadcaster);
			deps.broadcaster.broadcast = (frame) => {
				frames.push(frame);
				broadcast(frame);
			};

			const result = await commands.recordWorkerFailure(process.id, {
				errorCode: "startup_timeout",
				message: "Worker timed out during startup",
				errorClass: "infrastructure",
			});

			expect(result.ok).toBe(false);
			expect(result.code).toBe("worker_reconcile_failed");
			expect(result.process).toMatchObject({
				selectedTurnId: "generate_plan",
				lifecycleStatus: "error",
			});
			expect(frames).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "process.toast",
						instanceId: process.id,
						payload: expect.objectContaining({
							eventType: "worker_failed",
							level: "error",
							message: "PROJ-457 · Generate the candidate plan needs attention",
							ttlMs: 1234,
						}),
					}),
				]),
			);
		});
	});
});
