import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	buildFailedTurnRecoveryMetadata,
	createGenericFailedTurnRecoveryContext,
} from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	builtinPiProvider,
	type Codec,
	createEmptyStructuralProcessState,
	defineModelProvider,
	defineModelProviders,
	defineProcess,
	emptyParamsCodec,
	type LeitwerkExtensionModule,
	parseStructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const structuralStateCodec: Codec<ReturnType<typeof createEmptyStructuralProcessState>> = {
	parse(value) {
		return parseStructuralProcessState(value);
	},
	serialize(value) {
		return value;
	},
};

const continueTurn = {
	id: "implement",
	description: "Implementation turn for continue HTTP tests",
	availableTools: [],
	kind: "llm" as const,
	completionMode: "turn_end" as const,
	branchType: "primary" as const,
	context: "fresh" as const,
	prompt: async () => "Continue the implementation",
	outcomes: {},
	turnEnd: { outcome: "completed" as const, params: {}, complete: true },
};

const continueProcess = defineProcess<
	Record<string, never>,
	ReturnType<typeof createEmptyStructuralProcessState>
>({
	id: "continue_http_test_process",
	displayName: "Continue HTTP Test Process",
	entry: "implement",
	turns: { implement: continueTurn },
	paramsCodec: emptyParamsCodec,
	stateCodec: structuralStateCodec,
	initialState() {
		return createEmptyStructuralProcessState();
	},
});

const continueExtension: LeitwerkExtensionModule = {
	manifest: { id: "continue-http-test", version: "0.1.0" },
	modelProviders: defineModelProviders((rawConfig) => [
		{
			definition: defineModelProvider({
				id: "continue-fixture-provider",
				parseConfig: () => ({ config: {} }),
				worker: builtinPiProvider("openai"),
				models: () => [{ modelId: "fixture-model", availability: "available" }],
				secrets: () => ({}),
			}),
			rawConfig,
		},
	]),
	setupCatalog(api) {
		api.registerProcess(continueProcess);
	},
};

const promptBranchDriftDetails = {
	operation: "prompt",
	anchorEntryId: "user-implementation",
	rejectedResultEntryId: "turn-stale",
} as const;

let harness: IntegrationHarness | undefined;
let tempRoot = "";

beforeAll(async () => {
	tempRoot = mkdtempSync(path.join(tmpdir(), "leitwerk-continue-http-"));
	harness = await createIntegrationHarness({
		extensionCatalog: buildExtensionCatalogFromModules([continueExtension]),
		inProcessWorkers: false,
		configOverride(config) {
			config.pi.model_profiles = [
				{
					id: "continue-fixture-profile",
					provider: "continue-fixture-provider",
					model_id: "fixture-model",
					thinking_level: "off",
				},
			];
			config.storage.tree_files_dir = path.join(tempRoot, "trees");
			config.storage.process_workspaces_dir = path.join(tempRoot, "workspaces");
			mkdirSync(config.storage.tree_files_dir, { recursive: true });
			mkdirSync(config.storage.process_workspaces_dir, { recursive: true });
		},
	});
});

afterAll(async () => {
	if (harness) {
		await harness.ctx.app.close();
	}
	rmSync(tempRoot, { recursive: true, force: true });
});

function requireHarness(): IntegrationHarness {
	if (!harness) {
		throw new Error("expected integration harness");
	}
	return harness;
}

function writeTreeEntries(instanceId: string, entries: readonly Record<string, unknown>[]) {
	const treeFile = path.join(requireHarness().config.storage.tree_files_dir, `${instanceId}.jsonl`);
	writeFileSync(treeFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
}

function writeContinueTree(instanceId: string) {
	writeTreeEntries(instanceId, [
		{
			type: "session",
			version: 3,
			id: "sess-1",
			timestamp: "2026-04-25T10:00:00.000Z",
			cwd: "/tmp/project",
		},
		{
			type: "message",
			id: "primary-leaf",
			parentId: null,
			timestamp: "2026-04-25T10:00:01.000Z",
			message: { role: "assistant", content: "Primary leaf" },
		},
		{
			type: "message",
			id: "assistant-timeout",
			parentId: "primary-leaf",
			timestamp: "2026-04-25T10:00:02.000Z",
			message: { role: "assistant", content: "Timed-out leaf" },
		},
	]);
}

function writeCompactionContinueTree(instanceId: string) {
	writeTreeEntries(instanceId, [
		{
			type: "session",
			version: 3,
			id: "sess-1",
			timestamp: "2026-04-25T10:00:00.000Z",
			cwd: "/tmp/project",
		},
		{
			type: "message",
			id: "primary-leaf",
			parentId: null,
			timestamp: "2026-04-25T10:00:01.000Z",
			message: { role: "assistant", content: "Primary leaf" },
		},
		{
			type: "message",
			id: "assistant-overflow",
			parentId: "primary-leaf",
			timestamp: "2026-04-25T10:00:02.000Z",
			message: {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "context_length_exceeded",
			},
		},
		{
			type: "compaction",
			id: "compact-after-overflow",
			parentId: "assistant-overflow",
			timestamp: "2026-04-25T10:00:03.000Z",
			summary: "Compacted failed context",
		},
		{
			type: "message",
			id: "later-continue",
			parentId: "compact-after-overflow",
			timestamp: "2026-04-25T10:00:05.000Z",
			message: { role: "user", content: "continue later" },
		},
	]);
}

function primaryLeafStateJson(entryId = "primary-leaf", turnRecordId = "trn_prev") {
	return JSON.stringify({
		...createEmptyStructuralProcessState(),
		semanticEntryRefs: { currentPrimaryPathLeaf: { entryId, turnRecordId } },
	});
}

function seedContinueProcess(input: {
	turnRecordId: string;
	lifecycleStatus?: "active" | "error";
	metadata?: Record<string, unknown> | null;
	primaryLeafEntryId?: string;
	primaryLeafTurnRecordId?: string;
	turnStatus?: "failed" | "running";
	attemptNumber?: number;
	resultPiEntryId?: string | null;
	endedAt?: string | null;
}) {
	const h = requireHarness();
	const lifecycleStatus = input.lifecycleStatus ?? "error";
	const turnStatus = input.turnStatus ?? "failed";
	const process = h.ctx.deps.processes.create({
		processId: "continue_http_test_process",
		selectedTurnId: "implement",
		lifecycleStatus,
		...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
		stateJson: primaryLeafStateJson(input.primaryLeafEntryId, input.primaryLeafTurnRecordId),
	});
	const lease = h.ctx.deps.leases.create({
		instanceId: process.id,
		workerId: `worker_${input.turnRecordId}`,
		state: "exited",
	});
	h.ctx.deps.leases.update(lease.id, {
		state: "exited",
		exitedAt: "2026-04-25T10:00:04.500Z",
	});
	const startRecordId = `tsr_${input.turnRecordId}`;
	h.ctx.deps.turnStarts.create({
		id: startRecordId,
		instanceId: process.id,
		turnId: "implement",
		turnType: "llm",
		proposedTurnRecordId: input.turnRecordId,
		startKind: "selected_turn",
		recoveryTurnRecordId: null,
		continuation: null,
		state: {
			kind: "accepted",
			start: {
				kind: "llm",
				model: { profileId: "test", providerId: "test", modelId: "test", thinkingLevel: "off" },
				providerOptions: {},
				providerWorkerConfig: null,
				piResourceSnapshotDigest: "test-digest",
				workerRuntimeProfileId: "test",
				piSettings: {},
			},
			turnRecordId: input.turnRecordId,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	const resultPiEntryId =
		input.resultPiEntryId !== undefined
			? input.resultPiEntryId
			: turnStatus === "failed"
				? "assistant-timeout"
				: undefined;
	h.ctx.deps.turnRecords.create({
		id: input.turnRecordId,
		instanceId: process.id,
		turnId: "implement",
		turnType: "llm",
		status: turnStatus,
		attemptNumber: input.attemptNumber ?? 1,
		turnStartRecordId: startRecordId,
		acceptedWorkerLeaseId: lease.id,
		pathType: "primary",
		forkPiEntryId: "primary-leaf",
		...(resultPiEntryId !== undefined ? { resultPiEntryId } : {}),
		startedAt: "2026-04-25T10:00:01.500Z",
		...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
	});
	h.ctx.deps.processes.update(process.id, {
		currentExecution: { kind: "worker_start", id: startRecordId },
	});
	writeContinueTree(process.id);
	return process;
}

function getProcess(instanceId: string) {
	return requireHarness().ctx.deps.processes.getById(instanceId);
}

function postContinue(
	process: { id: string },
	turnRecordId: string,
	payload?: Record<string, unknown>,
) {
	return requireHarness().ctx.app.inject({
		method: "POST",
		url: `/api/processes/${process.id}/turn-records/${turnRecordId}/continue`,
		...(payload ? { payload } : {}),
	});
}

describe("POST /api/processes/:instanceId/turn-records/:turnRecordId/continue", () => {
	it("accepts a custom prompt and persists it into continuation metadata", async () => {
		const process = seedContinueProcess({
			turnRecordId: "trn_impl_1",
			metadata: buildFailedTurnRecoveryMetadata("trn_impl_1", {
				suggestedContinuePrompt: "Call markdown_result now with the final summary.",
				failureCode: "missing_markdown_result",
				missingToolNames: ["markdown_result"],
			}),
		});

		const response = await postContinue(process, "trn_impl_1", {
			prompt: "Please call markdown_result with the final summary.",
		});

		expect(response.statusCode).toBe(200);
		expect(getProcess(process.id)).toMatchObject({
			metadata: {
				continueFromTurnRecordId: "trn_impl_1",
				continueFromPiEntryId: "assistant-timeout",
				continuePrompt: "Please call markdown_result with the final summary.",
			},
		});
	});

	it("keeps a previously approved continue prompt when continuing is rescheduled", async () => {
		const process = seedContinueProcess({
			turnRecordId: "trn_impl_reschedule",
			metadata: {
				continuePrompt: "Use the operator-approved prompt.",
				...buildFailedTurnRecoveryMetadata("trn_impl_reschedule", {
					suggestedContinuePrompt: "Generic recovery prompt.",
				}),
			},
		});

		const response = await postContinue(process, "trn_impl_reschedule");

		expect(response.statusCode).toBe(200);
		expect(getProcess(process.id)).toMatchObject({
			metadata: {
				continueFromTurnRecordId: "trn_impl_reschedule",
				continueFromPiEntryId: "assistant-timeout",
				continuePrompt: "Use the operator-approved prompt.",
			},
		});
	});

	it("rejects continuation after a non-continuable failure even when saved branch entries exist", async () => {
		const h = requireHarness();
		const process = seedContinueProcess({
			turnRecordId: "trn_impl_drift",
			lifecycleStatus: "active",
			turnStatus: "running",
		});

		const failed = await h.ctx.deps.processEngine.recordTurnFailed(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_impl_drift",
			turnId: "implement",
			turnType: "llm",
			pathType: "primary",
			forkPiEntryId: "primary-leaf",
			resultPiEntryId: null,
			errorSummary: "Turn completed on a different Pi branch",
			errorClass: "infrastructure",
			failureCode: "branch_drift",
			failureDetails: promptBranchDriftDetails,
			recoveryContext: createGenericFailedTurnRecoveryContext(),
		});
		expect(failed.ok).toBe(true);

		const response = await postContinue(process, "trn_impl_drift");

		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({ code: "invalid_transition" });
		const storedProcess = getProcess(process.id);
		expect(storedProcess).toMatchObject({
			lifecycleStatus: "error",
			currentExecution: { kind: "worker_start", id: "tsr_trn_impl_drift" },
		});
		expect(storedProcess?.metadata ?? {}).not.toHaveProperty("continueFromPiEntryId");
		expect(storedProcess?.metadata ?? {}).not.toHaveProperty("failedTurnRecovery");
		const turnFailedEvent = h.ctx.deps.events
			.listByInstance(process.id, 10)
			.find((event) => event.eventType === "turn_failed");
		expect(turnFailedEvent?.data).toMatchObject({
			turnRecordId: "trn_impl_drift",
			failureCode: "branch_drift",
			failureDetails: promptBranchDriftDetails,
		});
	});

	it("continues from a failed compaction result leaf without drifting into later branches", async () => {
		const process = seedContinueProcess({
			turnRecordId: "trn_impl_compacted",
			metadata: buildFailedTurnRecoveryMetadata("trn_impl_compacted"),
			resultPiEntryId: "compact-after-overflow",
			endedAt: "2026-04-25T10:00:04.000Z",
		});
		writeCompactionContinueTree(process.id);

		const response = await postContinue(process, "trn_impl_compacted");

		expect(response.statusCode).toBe(200);
		expect(getProcess(process.id)).toMatchObject({
			lifecycleStatus: "active",
			metadata: {
				continueFromTurnRecordId: "trn_impl_compacted",
				continueFromPiEntryId: "compact-after-overflow",
			},
		});
		expect(getProcess(process.id)?.metadata ?? {}).not.toMatchObject({
			continuePrompt: "continue later",
		});
	});

	it("allows primary-turn continuation when the failed branch leaf exists even if currentPrimaryPathLeaf is stale", async () => {
		const process = seedContinueProcess({
			turnRecordId: "trn_impl_stale",
			metadata: buildFailedTurnRecoveryMetadata("trn_impl_stale"),
			primaryLeafEntryId: "stale-primary-leaf",
			primaryLeafTurnRecordId: "trn_prev_stale",
			attemptNumber: 2,
		});

		const response = await postContinue(process, "trn_impl_stale");

		expect(response.statusCode).toBe(200);
		expect(getProcess(process.id)).toMatchObject({
			lifecycleStatus: "active",
			metadata: {
				continueFromTurnRecordId: "trn_impl_stale",
				continueFromPiEntryId: "assistant-timeout",
			},
		});
	});
});
