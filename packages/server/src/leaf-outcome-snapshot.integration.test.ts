import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import {
	type Codec,
	createEmptyStructuralProcessState,
	defineProcess,
	type LeitwerkExtensionModule,
	llmTurn,
	REQUIRED_MARKDOWN_RESULT_TURN_RESULT,
	type StructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { afterEach, describe, expect, it } from "vitest";

const harnesses: Array<IntegrationHarness<Record<string, never>>> = [];

const simpleParamsCodec: Codec<{ prompt: string }> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		return {
			prompt:
				typeof (record as { prompt?: unknown }).prompt === "string"
					? (record as { prompt: string }).prompt
					: "",
		};
	},
	serialize(value) {
		return value;
	},
};

const structuralStateCodec: Codec<StructuralProcessState> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		const structural = createEmptyStructuralProcessState();
		return {
			...structural,
			...(record as StructuralProcessState),
		};
	},
	serialize(value) {
		return value;
	},
};

function createCaptureTurn() {
	return llmTurn<{ prompt: string }, StructuralProcessState>({
		description: "Produce a captured leaf outcome",
		availableTools: [],
		completionMode: "turn_end" as const,
		branchType: "primary" as const,
		context: "fresh" as const,
		prompt: async () => "Capture the current leaf outcome",
		outcomes: {},
		turnEnd: {
			outcome: "completed" as const,
			params: {},
			complete: true,
		},
		turnResultMarkdown: REQUIRED_MARKDOWN_RESULT_TURN_RESULT,
		resultSemanticRef: "plan",
	});
}

function createReviewCaptureTurn() {
	return llmTurn<{ prompt: string }, StructuralProcessState>({
		description: "Produce a captured review leaf outcome",
		availableTools: [],
		completionMode: "turn_end" as const,
		branchType: "leaf_branch" as const,
		context: "full" as const,
		prompt: async () => "Capture the latest review leaf outcome",
		outcomes: {},
		turnEnd: {
			outcome: "completed" as const,
			params: {},
			complete: true,
		},
		resultSemanticRef: "review",
	});
}

const captureSuccessTurnId = "capture_leaf_outcome_success";
const captureSuccessProcess = defineProcess<{ prompt: string }, StructuralProcessState>({
	id: "capture_success_process",
	displayName: "Capture Success Process",
	entry: captureSuccessTurnId,
	turns: { [captureSuccessTurnId]: createCaptureTurn() },
	paramsCodec: simpleParamsCodec,
	stateCodec: structuralStateCodec,
	initialState() {
		return createEmptyStructuralProcessState();
	},
	worker(api) {
		api.start(captureSuccessTurnId);
	},
	ui(api) {
		api.leafOutcome({
			rendererId: "test:capture_success_process.leaf_outcome",
			capture(ctx) {
				const leafEntry = ctx.readLeafEntry();
				const leafMessage =
					typeof leafEntry?.message?.content === "string" ? leafEntry.message.content : null;
				return {
					rendererId: "test:capture_success_process.leaf_outcome",
					props: {
						prompt: ctx.params.prompt,
						leafEntryId: ctx.leaf.entryId,
						hasLeafEntry: leafEntry !== null,
					},
					fallbackMarkdown: ctx.turnRecord?.turnResultMarkdown ?? leafMessage,
				};
			},
		});
	},
});

const captureSuccessExtension: LeitwerkExtensionModule = {
	manifest: { id: "capture-success-test", version: "0.1.0" },
	setupCatalog(api) {
		api.registerProcess(captureSuccessProcess);
	},
};

const captureReviewTurnId = "capture_leaf_outcome_review";
const captureReviewProcess = defineProcess<{ prompt: string }, StructuralProcessState>({
	id: "capture_review_process",
	displayName: "Capture Review Process",
	entry: captureReviewTurnId,
	turns: { [captureReviewTurnId]: createReviewCaptureTurn() },
	paramsCodec: simpleParamsCodec,
	stateCodec: structuralStateCodec,
	initialState() {
		return createEmptyStructuralProcessState();
	},
	worker(api) {
		api.start(captureReviewTurnId);
	},
	ui(api) {
		api.leafOutcome({
			rendererId: "test:capture_review_process.leaf_outcome",
			capture(ctx) {
				const leafEntry = ctx.readLeafEntry();
				const leafMessage =
					typeof leafEntry?.message?.content === "string" ? leafEntry.message.content : null;
				return {
					rendererId: "test:capture_review_process.leaf_outcome",
					props: {
						leafEntryId: ctx.leaf.entryId,
						latestReviewEntryId: ctx.state.semanticEntryRefs.review?.entryId ?? null,
						currentPrimaryPathLeafEntryId:
							ctx.state.semanticEntryRefs.currentPrimaryPathLeaf?.entryId ?? null,
					},
					fallbackMarkdown: leafMessage,
				};
			},
		});
	},
});

const captureReviewExtension: LeitwerkExtensionModule = {
	manifest: { id: "capture-review-test", version: "0.1.0" },
	setupCatalog(api) {
		api.registerProcess(captureReviewProcess);
	},
};

const captureErrorTurnId = "capture_leaf_outcome_error";
const captureErrorProcess = defineProcess<{ prompt: string }, StructuralProcessState>({
	id: "capture_error_process",
	displayName: "Capture Error Process",
	entry: captureErrorTurnId,
	turns: { [captureErrorTurnId]: createCaptureTurn() },
	paramsCodec: simpleParamsCodec,
	stateCodec: structuralStateCodec,
	initialState() {
		return createEmptyStructuralProcessState();
	},
	worker(api) {
		api.start(captureErrorTurnId);
	},
	ui(api) {
		api.leafOutcome({
			rendererId: "test:capture_error_process.leaf_outcome",
			capture() {
				throw new Error("capture exploded");
			},
		});
	},
});

const captureErrorExtension: LeitwerkExtensionModule = {
	manifest: { id: "capture-error-test", version: "0.1.0" },
	setupCatalog(api) {
		api.registerProcess(captureErrorProcess);
	},
};

afterEach(async () => {
	while (harnesses.length > 0) {
		const harness = harnesses.pop();
		await harness?.ctx.app.close();
	}
});

function baseStateJson(
	rootEntryId: string,
	overrides: Partial<StructuralProcessState["semanticEntryRefs"]> = {},
): string {
	return JSON.stringify({
		...createEmptyStructuralProcessState(),
		semanticEntryRefs: {
			rootEntry: { entryId: rootEntryId, turnRecordId: null },
			currentPrimaryPathLeaf: { entryId: rootEntryId, turnRecordId: null },
			plan: null,
			review: null,
			...overrides,
		},
	});
}

async function writeTreeFile(
	harness: IntegrationHarness<Record<string, never>>,
	instanceId: string,
	entries: readonly Record<string, unknown>[],
) {
	await mkdir(harness.config.storage.tree_files_dir, { recursive: true });
	const sessionEntries = [
		{
			type: "session",
			version: 3,
			id: `${instanceId}-session`,
			timestamp: "2026-04-18T00:00:00.000Z",
			cwd: process.cwd(),
		},
		...entries,
	];
	await writeFile(
		path.join(harness.config.storage.tree_files_dir, `${instanceId}.jsonl`),
		`${sessionEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf8",
	);
}

function seedAcceptedLlmTurn(
	harness: IntegrationHarness<Record<string, never>>,
	input: {
		instanceId: string;
		turnRecordId: string;
		turnId: string;
		pathType: "primary" | "leaf_branch";
		forkPiEntryId: string;
		startedAt: string;
	},
) {
	const lease = harness.ctx.deps.leases.create({
		instanceId: input.instanceId,
		workerId: `worker_${input.turnRecordId}`,
		state: "busy",
	});
	const turnStartRecordId = `tsr_${input.turnRecordId}`;
	harness.ctx.deps.turnStarts.create({
		id: turnStartRecordId,
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
			turnRecordId: input.turnRecordId,
			acceptedWorkerLeaseId: lease.id,
		},
	});
	harness.ctx.deps.turnRecords.create({
		id: input.turnRecordId,
		instanceId: input.instanceId,
		turnId: input.turnId,
		turnType: "llm",
		status: "running",
		attemptNumber: 1,
		turnStartRecordId,
		acceptedWorkerLeaseId: lease.id,
		pathType: input.pathType,
		forkPiEntryId: input.forkPiEntryId,
		startedAt: input.startedAt,
	});
	harness.ctx.deps.processes.update(input.instanceId, {
		currentExecution: { kind: "worker_start", id: turnStartRecordId },
	});
}

describe("leaf outcome snapshot capture", () => {
	it("captures a durable leaf outcome snapshot on successful primary-path turn completion and exposes it via process detail", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([captureSuccessExtension]),
		});
		harnesses.push(harness);

		const process = harness.ctx.deps.processes.create({
			processId: "capture_success_process",
			lifecycleStatus: "active",
			selectedTurnId: captureSuccessTurnId,
			paramsJson: JSON.stringify({ prompt: "Write a short answer" }),
			stateJson: baseStateJson("root-user"),
		});
		seedAcceptedLlmTurn(harness, {
			instanceId: process.id,
			turnRecordId: "trn_success",
			turnId: captureSuccessTurnId,
			pathType: "primary",
			forkPiEntryId: "root-user",
			startedAt: "2026-04-18T10:00:00.000Z",
		});
		await writeTreeFile(harness, process.id, [
			{
				id: "root-user",
				parentId: null,
				type: "user",
				timestamp: "2026-04-18T09:59:00.000Z",
				message: { role: "user", content: "Write a short answer" },
			},
			{
				id: "assistant-plan",
				parentId: "root-user",
				type: "assistant",
				timestamp: "2026-04-18T10:01:00.000Z",
				message: { role: "assistant", content: "## Final answer\n\nHello" },
			},
		]);

		const result = await harness.ctx.deps.processEngine.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_success",
			turnId: captureSuccessTurnId,
			turnType: "llm",
			outcome: "completed",
			params: {},
			pathType: "primary",
			forkPiEntryId: "root-user",
			resultPiEntryId: "assistant-plan",
			turnResultMarkdown: "## Final answer\n\nHello",
			rootEntryId: "root-user",
		});

		expect(result.ok).toBe(true);
		const snapshots = harness.ctx.deps.leafOutcomeSnapshots.listByInstance(process.id);
		expect(snapshots).toEqual([
			expect.objectContaining({
				leafEntryId: "assistant-plan",
				turnRecordId: "trn_success",
				rendererId: "test:capture_success_process.leaf_outcome",
				status: "ready",
				fallbackMarkdown: "## Final answer\n\nHello",
				props: expect.objectContaining({
					prompt: "Write a short answer",
					leafEntryId: "assistant-plan",
					hasLeafEntry: true,
				}),
			}),
		]);
		expect(snapshots[0]?.anchoredAt).toBe(
			harness.ctx.deps.turnRecords.getById("trn_success")?.endedAt,
		);

		const response = await fetch(`${harness.address}/api/processes/${process.id}`);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.definesLeafOutcome).toBe(true);
		expect(body.leafOutcomeSnapshots).toEqual([
			expect.objectContaining({
				leafEntryId: "assistant-plan",
				status: "ready",
				fallbackMarkdown: "## Final answer\n\nHello",
			}),
		]);
	});

	it("captures a durable review-leaf outcome snapshot when review changes", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([captureReviewExtension]),
		});
		harnesses.push(harness);

		const process = harness.ctx.deps.processes.create({
			processId: "capture_review_process",
			lifecycleStatus: "active",
			selectedTurnId: captureReviewTurnId,
			paramsJson: JSON.stringify({ prompt: "Review the current draft" }),
			stateJson: baseStateJson("root-user", {
				currentPrimaryPathLeaf: { entryId: "assistant-primary", turnRecordId: "trn_draft" },
			}),
		});
		seedAcceptedLlmTurn(harness, {
			instanceId: process.id,
			turnRecordId: "trn_review",
			turnId: captureReviewTurnId,
			pathType: "leaf_branch",
			forkPiEntryId: "assistant-primary",
			startedAt: "2026-04-18T10:06:00.000Z",
		});
		await writeTreeFile(harness, process.id, [
			{
				id: "root-user",
				parentId: null,
				type: "user",
				timestamp: "2026-04-18T10:04:00.000Z",
				message: { role: "user", content: "Review the current draft" },
			},
			{
				id: "assistant-primary",
				parentId: "root-user",
				type: "assistant",
				timestamp: "2026-04-18T10:05:00.000Z",
				message: { role: "assistant", content: "## Draft\n\nPrimary poem" },
			},
			{
				id: "assistant-review",
				parentId: "assistant-primary",
				type: "assistant",
				timestamp: "2026-04-18T10:07:00.000Z",
				message: { role: "assistant", content: "Review leaf snapshot" },
			},
		]);

		const result = await harness.ctx.deps.processEngine.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_review",
			turnId: captureReviewTurnId,
			turnType: "llm",
			outcome: "completed",
			params: {},
			pathType: "leaf_branch",
			forkPiEntryId: "assistant-primary",
			resultPiEntryId: "assistant-review",
			turnResultMarkdown: null,
			rootEntryId: "root-user",
		});

		expect(result.ok).toBe(true);
		expect(harness.ctx.deps.leafOutcomeSnapshots.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				leafEntryId: "assistant-review",
				turnRecordId: "trn_review",
				rendererId: "test:capture_review_process.leaf_outcome",
				status: "ready",
				fallbackMarkdown: "Review leaf snapshot",
				props: {
					leafEntryId: "assistant-review",
					latestReviewEntryId: "assistant-review",
					currentPrimaryPathLeafEntryId: "assistant-primary",
				},
			}),
		]);
	});

	it("preserves turn-record capture context when recordTurnOutcome creates the missing row", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([captureSuccessExtension]),
		});
		harnesses.push(harness);

		const process = harness.ctx.deps.processes.create({
			processId: "capture_success_process",
			lifecycleStatus: "active",
			selectedTurnId: captureSuccessTurnId,
			paramsJson: JSON.stringify({ prompt: "Use the payload markdown" }),
			stateJson: baseStateJson("root-user"),
		});
		seedAcceptedLlmTurn(harness, {
			instanceId: process.id,
			turnRecordId: "trn_missing",
			turnId: captureSuccessTurnId,
			pathType: "primary",
			forkPiEntryId: "root-user",
			startedAt: "2026-04-18T10:04:00.000Z",
		});
		await writeTreeFile(harness, process.id, [
			{
				id: "root-user",
				parentId: null,
				type: "user",
				timestamp: "2026-04-18T10:04:00.000Z",
				message: { role: "user", content: "Use the payload markdown" },
			},
			{
				id: "assistant-created",
				parentId: "root-user",
				type: "assistant",
				timestamp: "2026-04-18T10:05:00.000Z",
				message: { role: "assistant", content: "Tree leaf fallback" },
			},
		]);

		const result = await harness.ctx.deps.processEngine.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_missing",
			turnId: captureSuccessTurnId,
			turnType: "llm",
			outcome: "completed",
			params: {},
			pathType: "primary",
			forkPiEntryId: "root-user",
			resultPiEntryId: "assistant-created",
			turnResultMarkdown:
				"## Payload markdown\n\nCaptured from the synthetic completed turn record.",
			rootEntryId: "root-user",
		});

		expect(result.ok).toBe(true);
		expect(harness.ctx.deps.turnRecords.getById("trn_missing")).toEqual(
			expect.objectContaining({
				id: "trn_missing",
				status: "succeeded",
				turnResultMarkdown:
					"## Payload markdown\n\nCaptured from the synthetic completed turn record.",
			}),
		);
		expect(harness.ctx.deps.leafOutcomeSnapshots.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				leafEntryId: "assistant-created",
				turnRecordId: "trn_missing",
				status: "ready",
				fallbackMarkdown:
					"## Payload markdown\n\nCaptured from the synthetic completed turn record.",
			}),
		]);
	});

	it("reuses an existing snapshot for the same selected leaf instead of recapturing it", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([captureSuccessExtension]),
		});
		harnesses.push(harness);

		const process = harness.ctx.deps.processes.create({
			processId: "capture_success_process",
			lifecycleStatus: "active",
			selectedTurnId: captureSuccessTurnId,
			paramsJson: JSON.stringify({ prompt: "Reuse the captured leaf" }),
			stateJson: baseStateJson("root-user"),
		});
		seedAcceptedLlmTurn(harness, {
			instanceId: process.id,
			turnRecordId: "trn_reuse",
			turnId: captureSuccessTurnId,
			pathType: "primary",
			forkPiEntryId: "root-user",
			startedAt: "2026-04-18T10:20:00.000Z",
		});
		await writeTreeFile(harness, process.id, [
			{ id: "root-user", parentId: null, type: "user", timestamp: "2026-04-18T10:19:00.000Z" },
			{
				id: "assistant-reuse",
				parentId: "root-user",
				type: "assistant",
				timestamp: "2026-04-18T10:21:00.000Z",
			},
		]);
		const existing = harness.ctx.deps.leafOutcomeSnapshots.create({
			id: "los_existing",
			instanceId: process.id,
			leafEntryId: "assistant-reuse",
			turnRecordId: "trn_reuse",
			rendererId: "test:capture_success_process.leaf_outcome",
			props: { prompt: "Existing" },
			fallbackMarkdown: "## Existing snapshot",
			status: "ready",
			anchoredAt: "2026-04-18T10:21:00.000Z",
		});

		const result = await harness.ctx.deps.processEngine.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_reuse",
			turnId: captureSuccessTurnId,
			turnType: "llm",
			outcome: "completed",
			params: {},
			pathType: "primary",
			forkPiEntryId: "root-user",
			resultPiEntryId: "assistant-reuse",
			turnResultMarkdown: "## New markdown",
			rootEntryId: "root-user",
		});

		expect(result.ok).toBe(true);
		expect(harness.ctx.deps.leafOutcomeSnapshots.listByInstance(process.id)).toEqual([existing]);
	});

	it("persists a capture_error snapshot when leaf outcome capture throws", async () => {
		const harness = await createIntegrationHarness({
			extensionCatalog: buildExtensionCatalogFromModules([captureErrorExtension]),
		});
		harnesses.push(harness);

		const process = harness.ctx.deps.processes.create({
			processId: "capture_error_process",
			lifecycleStatus: "active",
			selectedTurnId: captureErrorTurnId,
			paramsJson: JSON.stringify({ prompt: "Capture the leaf" }),
			stateJson: baseStateJson("root-user"),
		});
		seedAcceptedLlmTurn(harness, {
			instanceId: process.id,
			turnRecordId: "trn_capture",
			turnId: captureErrorTurnId,
			pathType: "primary",
			forkPiEntryId: "root-user",
			startedAt: "2026-04-18T10:10:00.000Z",
		});
		await writeTreeFile(harness, process.id, [
			{ id: "root-user", parentId: null, type: "user", timestamp: "2026-04-18T10:09:00.000Z" },
			{
				id: "assistant-capture",
				parentId: "root-user",
				type: "assistant",
				timestamp: "2026-04-18T10:11:00.000Z",
			},
		]);

		const result = await harness.ctx.deps.processEngine.recordTurnOutcome(process.id, {
			instanceId: process.id,
			turnRecordId: "trn_capture",
			turnId: captureErrorTurnId,
			turnType: "llm",
			outcome: "completed",
			params: {},
			pathType: "primary",
			forkPiEntryId: "root-user",
			resultPiEntryId: "assistant-capture",
			turnResultMarkdown: "## Snapshot",
			rootEntryId: "root-user",
		});

		expect(result.ok).toBe(true);
		expect(harness.ctx.deps.leafOutcomeSnapshots.listByInstance(process.id)).toEqual([
			expect.objectContaining({
				leafEntryId: "assistant-capture",
				status: "capture_error",
				rendererId: "test:capture_error_process.leaf_outcome",
				warningCode: "capture_exception",
				warningMessage: "capture exploded",
			}),
		]);
	});
});
