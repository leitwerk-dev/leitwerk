import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RepositoryChangeState as LocalRepoChangeState } from "@leitwerk-dev/coding/repository-change-state";
import type { ProcessInstance, ProcessSemanticEntryRefKey } from "@leitwerk-dev/domain";
import { buildWorkerRuntimeDefinition } from "@leitwerk-dev/extension-runtime";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { createTestDeps } from "@leitwerk-dev/server/testing";
import { FakeGitOps } from "@leitwerk-dev/test-support/fakes";
import {
	createStubToolScriptController,
	createTestLlmWorkerStartPayload,
	createWorkerRuntimeHarness,
	StubPiTreeHandleFactory,
} from "@leitwerk-dev/test-support/worker-testing";
import type { InputDelivery, WorkerStartPayload } from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { buildProcessActionRegistry } from "../../../packages/server/src/process-action-registry.js";
import { createProcessEngine } from "../../../packages/server/src/process-engine/engine.js";
import { createProcessOperationCoordinator } from "../../../packages/server/src/process-operation-coordinator.js";
import { createFilesystemSessionReader } from "../../../packages/server/src/process-session-store.js";
import { buildProcessUiRegistry } from "../../../packages/server/src/process-ui-registry.js";
import { localRepoChangeActionIds } from "./actions.js";
import localRepoChangeExtension from "./index.js";
import type { LocalRepoChangeParams } from "./params.js";
import { localRepoChangeProcess } from "./process-definition.js";

const defaultParams: LocalRepoChangeParams = {
	launchKind: "requested_change",
	repoLocator: "https://example.com/local-repo.git",
	baseBranch: "main",
	workBranch: "feature/collapsible-sidebar",
	prompt: "Make the sidebar collapsible.",
};

const candidatePlanMarkdown = `# Candidate plan

1. Inspect the sidebar.
2. Add collapsed state.
3. Cover the behavior with tests.`;
const implementationMarkdown = `## Implementation

Added a collapsible sidebar and tests.`;
const planReviewMarkdown = `## Plan review

Looks ready.`;
const implementationReviewMarkdown = `## Implementation review

Looks ready.`;

const extensionCatalog = await buildExtensionCatalogFromModules([localRepoChangeExtension]);
const processGraphs = extensionCatalog.processes;
const processActionRegistry = buildProcessActionRegistry(extensionCatalog);
const processUiRegistry = buildProcessUiRegistry(extensionCatalog);

type Harness = {
	deps: ReturnType<typeof createTestDeps>;
	commands: ReturnType<typeof createProcessEngine>;
	instanceId: string;
	params: LocalRepoChangeParams;
	runtimeRoot: string;
	piFactory: StubPiTreeHandleFactory;
	scriptController: ReturnType<typeof createStubToolScriptController>;
};

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
	const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

type StartedTurn = {
	turnRecordId: string;
	turnId: string;
	turnType: string;
	pathType: string;
	forkPiEntryId: string | null | undefined;
};

type CompletedTurn = {
	turnId: string;
	turnRecordId: string;
	turnType?: string;
	outcome: string;
	params: Record<string, unknown>;
	pathType: string | undefined;
	forkPiEntryId: string | null | undefined;
	resultPiEntryId: string | null | undefined;
	rootEntryId: string | null | undefined;
	turnResultMarkdown: string | null | undefined;
};

type TurnExecutionTrace = {
	started: { pathType: string; forkPiEntryId: string | null | undefined };
	outcome: CompletedTurn;
	prompt: string | null;
	promptCountDelta: number;
};

function createHarness(overrides: Partial<LocalRepoChangeParams> = {}): Harness {
	const params: LocalRepoChangeParams = { ...defaultParams, ...overrides };
	const deps = createTestDeps();
	const treeFilesDir = createTempDir("local-repo-change-tree-files");
	const process = deps.processes.create({
		processId: localRepoChangeProcess.id,
		selectedTurnId: "generate_plan",
		lifecycleStatus: "active",
		paramsJson: JSON.stringify(params),
		stateJson: JSON.stringify(localRepoChangeProcess.initialState(params)),
	});
	deps.projects.create({
		instanceId: process.id,
		key: "repo",
		repoLocator: params.repoLocator,
		repoLocatorKind: "remote_url",
		baseBranch: params.baseBranch,
		workBranch: params.workBranch,
	});

	const commands = createProcessEngine({
		...deps,
		processOperations: createProcessOperationCoordinator(),
		processGraphs,
		getSupervisor: () => undefined,
		getProcessActionRegistry: () => processActionRegistry,
		getProcessUiRegistry: () => processUiRegistry,
		sessionReader: createFilesystemSessionReader(treeFilesDir),
	});

	const scriptController = createStubToolScriptController();
	return {
		deps,
		commands,
		instanceId: process.id,
		params,
		runtimeRoot: createTempDir("local-repo-change-runtime"),
		piFactory: new StubPiTreeHandleFactory({ toolCallScriptResolver: scriptController.resolver }),
		scriptController,
	};
}

function currentProcess(harness: Harness): ProcessInstance {
	const process = harness.deps.processes.getById(harness.instanceId);
	if (!process) {
		throw new Error("Expected process instance to exist");
	}
	return process;
}

function currentState(harness: Harness): LocalRepoChangeState {
	return currentProcess(harness).stateJson
		? localRepoChangeProcess.stateCodec.parse(JSON.parse(currentProcess(harness).stateJson ?? "{}"))
		: localRepoChangeProcess.initialState(harness.params);
}

function currentProjects(harness: Harness) {
	return harness.deps.projects.listByInstance(harness.instanceId);
}

function resolveTurnResultMarkdownBySemanticRef(
	harness: Harness,
): Partial<Record<ProcessSemanticEntryRefKey, string>> | undefined {
	const bySemanticRef: Partial<Record<ProcessSemanticEntryRefKey, string>> = {};
	for (const ref of Object.keys(
		currentState(harness).semanticEntryRefs,
	) as ProcessSemanticEntryRefKey[]) {
		const turnRecordId = currentState(harness).semanticEntryRefs[ref]?.turnRecordId;
		const markdown = turnRecordId
			? harness.deps.turnRecords.getById(turnRecordId)?.turnResultMarkdown?.trim()
			: null;
		if (markdown) {
			bySemanticRef[ref] = markdown;
		}
	}
	return Object.keys(bySemanticRef).length > 0 ? bySemanticRef : undefined;
}

function resolveTurnResultMarkdownByProduct(harness: Harness): Record<string, string> | undefined {
	const byProduct: Record<string, string> = {};
	for (const [productName, ref] of Object.entries(currentState(harness).productRefs ?? {})) {
		const markdown = ref?.turnRecordId
			? harness.deps.turnRecords.getById(ref.turnRecordId)?.turnResultMarkdown?.trim()
			: null;
		if (markdown) {
			byProduct[productName] = markdown;
		}
	}
	return Object.keys(byProduct).length > 0 ? byProduct : undefined;
}

async function executeAction(
	harness: Harness,
	actionId: string,
	input: Record<string, unknown> = {},
): Promise<void> {
	const result = await harness.commands.executeProcessAction(harness.instanceId, actionId, input);
	if (!result.ok) {
		throw new Error(result.code ?? result.error);
	}
}

async function recordSelectedTurnCompletion(
	harness: Harness,
	startedTurn: StartedTurn,
	completedTurn: CompletedTurn,
): Promise<void> {
	harness.deps.turnRecords.create({
		id: startedTurn.turnRecordId,
		instanceId: harness.instanceId,
		turnId: startedTurn.turnId,
		turnType: startedTurn.turnType as "llm" | "automatic",
		status: "running",
		pathType: startedTurn.pathType as "primary" | "root_branch",
		forkPiEntryId: startedTurn.forkPiEntryId ?? null,
	});
	const outcomeResult = await harness.commands.recordTurnOutcome(harness.instanceId, {
		instanceId: harness.instanceId,
		turnRecordId: completedTurn.turnRecordId,
		turnId: completedTurn.turnId,
		turnType: (completedTurn.turnType ?? startedTurn.turnType) as "llm" | "automatic",
		outcome: completedTurn.outcome,
		params: completedTurn.params,
		pathType: (completedTurn.pathType ?? "primary") as "primary" | "root_branch",
		forkPiEntryId: completedTurn.forkPiEntryId ?? null,
		resultPiEntryId: completedTurn.resultPiEntryId ?? null,
		turnResultMarkdown: completedTurn.turnResultMarkdown ?? null,
		rootEntryId: completedTurn.rootEntryId ?? null,
	});
	if (!outcomeResult.ok) {
		throw new Error(outcomeResult.message);
	}
}

let runtimeTurnSequence = 1;

function runtimeStartPayload(harness: Harness, turnRecordId: string): WorkerStartPayload {
	const process = currentProcess(harness);
	const pendingInputs: InputDelivery[] = harness.deps.inputs
		.listUnconsumed(harness.instanceId)
		.map((input) => ({
			inputId: input.id,
			sequence: input.sequence,
			source: input.source,
			kind: input.kind,
			target: input.target,
			receivedAt: input.receivedAt,
			bodyMarkdown: input.bodyMarkdown,
		}));
	return createTestLlmWorkerStartPayload({
		root: harness.runtimeRoot,
		processSnapshot: process,
		projectSnapshots: currentProjects(harness),
		turnResultMarkdownBySemanticRef: resolveTurnResultMarkdownBySemanticRef(harness),
		turnResultMarkdownByProduct: resolveTurnResultMarkdownByProduct(harness),
		pendingInputs,
		workerLeaseId: `lease_${turnRecordId}`,
		startRecordId: `start_${turnRecordId}`,
		turnRecordId,
		model: {
			profileId: "local-repo-change-test",
			providerId: "openai",
			modelId: "test-model",
			thinkingLevel: "low",
		},
		credential: { providerId: "openai", revision: 1, values: { apiKey: "test" } },
		resume: harness.piFactory.sessions.length > 0,
		now: new Date().toISOString(),
	});
}

async function runSelectedTurn(
	harness: Harness,
	script: ReadonlyArray<{ toolName: string; args: Record<string, unknown> }>,
): Promise<TurnExecutionTrace> {
	harness.scriptController.set([{ calls: script }]);
	const turnRecordId = `trn_runtime_${runtimeTurnSequence++}`;
	const startPayload = runtimeStartPayload(harness, turnRecordId);
	const resolvedWorkerProcess = buildWorkerRuntimeDefinition(localRepoChangeProcess, {
		paramsJson: startPayload.processSnapshot.paramsJson,
		stateJson: startPayload.processSnapshot.stateJson,
	});
	if (!resolvedWorkerProcess) throw new Error("Expected local repo change process to resolve");
	const runtime = createWorkerRuntimeHarness({
		config: { instanceId: harness.instanceId, workerId: "worker_local_repo_change" },
		adapters: {
			piFactory: harness.piFactory,
			gitOps: new FakeGitOps(new Map([[harness.params.repoLocator, {}]])),
			resolveWorkerProcess: () => resolvedWorkerProcess,
		},
	});
	const outcomeMessage = await runtime.startLlmTo("worker.turn_outcome", startPayload);
	if (outcomeMessage.payload.turnRecordId !== turnRecordId) {
		throw new Error(`Expected turn '${startPayload.turnStart.turnId}' to finish`);
	}
	for (const consumed of runtime.outgoing.filter(
		(message) => message.type === "worker.input_consumed",
	)) {
		if (consumed.type === "worker.input_consumed")
			harness.deps.inputs.markConsumed(consumed.payload.inputId);
	}
	const completedTurn: CompletedTurn = { ...outcomeMessage.payload };
	const startedTurn: StartedTurn = {
		turnRecordId,
		turnId: completedTurn.turnId,
		turnType: completedTurn.turnType ?? "llm",
		pathType: completedTurn.pathType ?? "primary",
		forkPiEntryId: completedTurn.forkPiEntryId,
	};
	await recordSelectedTurnCompletion(harness, startedTurn, completedTurn);
	const handle = harness.piFactory.sessions.at(-1);
	if (!handle) throw new Error("Expected the runtime to open a Pi handle");
	const customPrompt = completedTurn.resultPiEntryId
		? handle
				.getBranch(completedTurn.resultPiEntryId)
				.findLast((entry) => entry.type === "custom_message")
		: undefined;
	const prompt =
		handle.prompts.at(-1) ??
		(customPrompt?.type === "custom_message" && typeof customPrompt.content === "string"
			? customPrompt.content
			: null);
	await runtime.stop("extension_turn_complete");
	return {
		started: { pathType: startedTurn.pathType, forkPiEntryId: startedTurn.forkPiEntryId },
		outcome: completedTurn,
		prompt,
		promptCountDelta: handle.prompts.length,
	};
}

describe("local repo change instance tree", () => {
	it("runs one end-to-end happy path and preserves branch/ref semantics", async () => {
		const harness = createHarness({ baseBranch: "release/2026.04" });

		const planRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: candidatePlanMarkdown } },
			{
				toolName: "plan_saved",
				args: {
					markdown: candidatePlanMarkdown,
					summary: "Plan saved",
					acceptanceCriteria: ["Sidebar collapses"],
				},
			},
		]);
		const afterPlanState = currentState(harness);
		expect(planRun.started).toEqual({ pathType: "primary", forkPiEntryId: null });
		expect(currentProcess(harness)).toMatchObject({
			selectedTurnId: "plan_decision",
			lifecycleStatus: "waiting",
		});
		expect(afterPlanState).not.toHaveProperty("latestPlanMarkdown");
		expect(afterPlanState.semanticEntryRefs.plan?.entryId).toBe(planRun.outcome.resultPiEntryId);
		const rootEntryId = afterPlanState.semanticEntryRefs.rootEntry?.entryId;
		expect(rootEntryId).toBe("custom-1");

		await executeAction(harness, localRepoChangeActionIds.runReview);
		const planReviewRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: planReviewMarkdown } },
			{ toolName: "no_issues", args: { markdown: planReviewMarkdown } },
		]);
		expect(planReviewRun.started).toEqual({ pathType: "root_branch", forkPiEntryId: null });
		expect(currentProcess(harness).selectedTurnId).toBe("plan_decision");
		expect(currentState(harness).semanticEntryRefs.currentPrimaryPathLeaf?.entryId).toBe(
			planRun.outcome.resultPiEntryId,
		);
		expect(currentState(harness).semanticEntryRefs.review?.entryId).toBe(
			planReviewRun.outcome.resultPiEntryId,
		);

		await executeAction(harness, localRepoChangeActionIds.approvePlan);
		const implementRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: implementationMarkdown } },
		]);
		expect(implementRun.started).toEqual({ pathType: "primary", forkPiEntryId: null });
		expect(currentProcess(harness)).toMatchObject({
			selectedTurnId: "implementation_decision",
			lifecycleStatus: "waiting",
		});
		expect(currentState(harness)).not.toHaveProperty("latestImplementationMarkdown");
		expect(currentState(harness).semanticEntryRefs.currentPrimaryPathLeaf?.entryId).toBe(
			implementRun.outcome.resultPiEntryId,
		);

		await executeAction(harness, localRepoChangeActionIds.runReview);
		const implementationReviewRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: implementationReviewMarkdown } },
			{ toolName: "no_issues", args: { markdown: implementationReviewMarkdown } },
		]);
		expect(implementationReviewRun.started).toEqual({
			pathType: "root_branch",
			forkPiEntryId: null,
		});
		expect(currentProcess(harness).selectedTurnId).toBe("implementation_decision");

		await executeAction(harness, localRepoChangeActionIds.finalizeChange);
		const commitMessageRun = await runSelectedTurn(harness, [
			{ toolName: "markdown_result", args: { markdown: "Implement the accepted plan" } },
		]);
		expect(currentState(harness).finalization.generatedCommitMessage).toBe(
			"Implement the accepted plan",
		);
		expect(currentProcess(harness).selectedTurnId).toBe("commit_and_merge");
		await recordSelectedTurnCompletion(
			harness,
			{
				turnRecordId: "trn_auto_finalize_1",
				turnId: "commit_and_merge",
				turnType: "automatic",
				pathType: "primary",
				forkPiEntryId: null,
			},
			{
				turnId: "commit_and_merge",
				turnRecordId: "trn_auto_finalize_1",
				turnType: "automatic",
				outcome: "finalized",
				params: {
					headSha: "abc123",
					mergeMode: "merge_commit",
					pushTarget: "origin/release/2026.04",
					usedConflictResolution: false,
				},
				pathType: "primary",
				forkPiEntryId: null,
				resultPiEntryId: null,
				rootEntryId,
				turnResultMarkdown: "## Finalized\n\nCommitted and merged.",
			},
		);
		expect(currentProcess(harness)).toMatchObject({
			selectedTurnId: null,
			lifecycleStatus: "completed",
		});
		expect(currentState(harness).finalization.finalizationSummaryMarkdown).toBe(
			"## Finalized\n\nCommitted and merged.",
		);

		expect(planReviewRun.prompt ?? "").toContain(defaultParams.prompt);
		expect(planReviewRun.prompt ?? "").toContain(candidatePlanMarkdown);
		expect(implementRun.prompt ?? "").toContain(candidatePlanMarkdown);
		expect(implementationReviewRun.prompt ?? "").toContain("release/2026.04");
		expect(implementationReviewRun.prompt ?? "").toContain(defaultParams.prompt);
		expect(implementationReviewRun.prompt ?? "").not.toContain(candidatePlanMarkdown);

		if (
			!rootEntryId ||
			!planReviewRun.outcome.resultPiEntryId ||
			!implementRun.outcome.resultPiEntryId ||
			!implementationReviewRun.outcome.resultPiEntryId ||
			!commitMessageRun.outcome.resultPiEntryId
		) {
			throw new Error("Expected root and result entry ids to be populated");
		}
		const piHandle = harness.piFactory.sessions.at(-1);
		if (!piHandle) throw new Error("Expected a persisted Pi tree");
		expect(piHandle.getLeafId()).toBe(implementRun.outcome.resultPiEntryId);
		expect(
			piHandle.getBranch(planReviewRun.outcome.resultPiEntryId).map((entry) => entry.id),
		).toEqual(["custom-3", "turn-4"]);
		expect(
			piHandle.getBranch(implementRun.outcome.resultPiEntryId).map((entry) => entry.id),
		).toEqual(["custom-5", "turn-6"]);
		expect(
			piHandle.getBranch(implementationReviewRun.outcome.resultPiEntryId).map((entry) => entry.id),
		).toEqual(["custom-7", "turn-8"]);
		expect(
			piHandle.getBranch(commitMessageRun.outcome.resultPiEntryId).map((entry) => entry.id),
		).toEqual(["custom-9", "turn-10"]);
	});
});
