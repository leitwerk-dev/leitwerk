import type { ProcessInstance } from "@leitwerk-dev/domain";
import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import { createWorkerProcessBuilder, type LlmTurnDefinition } from "@leitwerk-dev/process-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedLlmSession } from "./bootstrap-session.js";

const executeLlmTurn = vi.fn();
vi.mock("./llm-turn-execution.js", () => ({ executeLlmTurn }));

const { executeSelectedTurn } = await import("./turn-execution.js");

function processSnapshot(): ProcessInstance {
	return {
		id: "proc_1",
		processId: "test_process",
		selectedTurnId: "analyze",
		lifecycleStatus: "active",
		currentExecution: { kind: "worker_start", id: "start_1" },
		planRevision: 0,
		title: null,
		externalId: null,
		externalUrl: null,
		metadata: {},
		defaultModelProfileId: null,
		initialDefaultModelProfileId: null,
		turnConfigsJson: null,
		selectedTurnModelProfileId: null,
		selectedTurnModelSource: null,
		paramsJson: "{}",
		stateJson: "{}",
		createdAt: new Date(),
		updatedAt: new Date(),
		closedAt: null,
	};
}

function llmProcess(definition: LlmTurnDefinition): ResolvedWorkerProcess {
	const builder = createWorkerProcessBuilder();
	builder.start("analyze");
	builder.turn("analyze", async (run) => {
		await run.turn(definition);
	});
	return {
		processId: "test_process",
		startTurnId: "analyze",
		turns: new Map([["analyze", { definition }]]) as never,
		definition: builder.getDefinition(),
		params: {},
		state: {},
	};
}

function session(process: ResolvedWorkerProcess, checkpoint?: unknown): PreparedLlmSession {
	return {
		resolvedWorkerProcess: process,
		processSnapshot: processSnapshot(),
		projectSnapshots: [],
		kind: "llm",
		selectedTurnId: "analyze",
		startRecordId: "start_1",
		proposedTurnRecordId: "turn_1",
		acceptedTurnRecordId: "turn_1",
		startKind: "selected_turn",
		...(checkpoint === undefined
			? {}
			: { llmPreparation: { sourceTurnRecordId: "turn_1", data: checkpoint } }),
		treeFile: "/tmp/tree.jsonl",
		workspaceRoot: "/tmp/workspace",
		activeModelProfileId: "test",
		piAvailable: true,
		preparedTurnStart: {
			pathType: "primary",
			contextMode: "fresh",
			startTarget: { kind: "session_root" },
			forkPiEntryId: null,
		},
		configSnapshot: {} as never,
		integrationTools: [],
		settings: {
			heartbeatIntervalMs: 30_000,
			turnMaxDurationMs: 30_000,
			turnInactivityTimeoutMs: 10_000,
			turnAbortGracePeriodMs: 1_000,
		},
	};
}

const scheduler = {
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	sleep: async () => {},
	now: () => new Date(),
};

async function run(definition: LlmTurnDefinition, checkpoint?: unknown) {
	const emissions: unknown[] = [];
	const process = llmProcess(definition);
	const result = await executeSelectedTurn({
		session: session(process, checkpoint),
		piHandle: {} as never,
		turnRecordId: "turn_1",
		targetedInputs: [],
		scheduler,
		resultImageTools: { create: () => null },
		integrationTools: [],
		signal: new AbortController().signal,
		emit: (emission) => emissions.push(emission),
	});
	return { emissions, result };
}

describe("LLM turn preparation execution", () => {
	beforeEach(() => {
		executeLlmTurn.mockReset();
		executeLlmTurn.mockResolvedValue({
			turnResult: { outcome: "done", params: {} },
			meta: { turnRecordId: "turn_1", turnType: "llm", pathType: "primary" },
		});
	});

	it("checkpoints preparation before invoking the LLM", async () => {
		const prepare = vi.fn(async () => ({ snapshotDir: "/tmp/snapshot" }));
		const { emissions, result } = await run({
			kind: "llm",
			description: "Analyze",
			availableTools: [],
			branchType: "primary",
			context: "fresh",
			prepare,
			prompt: () => "Analyze",
			turnEnd: { outcome: "done", complete: true },
		});

		expect(prepare).toHaveBeenCalledOnce();
		expect(emissions).toContainEqual({
			kind: "prepared",
			turnRecordId: "turn_1",
			data: { snapshotDir: "/tmp/snapshot" },
		});
		expect(executeLlmTurn).toHaveBeenCalledWith(
			expect.objectContaining({ prepared: { snapshotDir: "/tmp/snapshot" } }),
		);
		expect(result).toMatchObject({ kind: "outcome", outcome: "done" });
	});

	it("reuses a durable checkpoint without running preparation again", async () => {
		const prepare = vi.fn();
		await run(
			{
				kind: "llm",
				description: "Analyze",
				availableTools: [],
				branchType: "primary",
				context: "fresh",
				prepare,
				prompt: () => "Analyze",
				turnEnd: { outcome: "done", complete: true },
			},
			{ snapshotDir: "/tmp/checkpoint" },
		);

		expect(prepare).not.toHaveBeenCalled();
		expect(executeLlmTurn).toHaveBeenCalledWith(
			expect.objectContaining({ prepared: { snapshotDir: "/tmp/checkpoint" } }),
		);
	});

	it("fails the LLM turn before prompting when preparation fails", async () => {
		const { result } = await run({
			kind: "llm",
			description: "Analyze",
			availableTools: [],
			branchType: "primary",
			context: "fresh",
			prepare: async () => {
				throw new Error("snapshot unavailable");
			},
			prompt: () => "Analyze",
			turnEnd: { outcome: "done", complete: true },
		});

		expect(executeLlmTurn).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			kind: "failed",
			failure: {
				failure: {
					errorClass: "infrastructure",
					message: expect.stringContaining("snapshot unavailable"),
				},
			},
		});
	});
});
