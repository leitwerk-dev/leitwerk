import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import { createTestProcessInstance } from "@leitwerk-dev/extension-runtime/testing";
import { createWorkerProcessBuilder } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import type { WorkerOperationEmission, WorkerOperationEmitter } from "../diagnostics.js";
import type { PreparedAutomaticSession } from "./bootstrap-session.js";
import { executeSelectedTurn } from "./turn-execution.js";

function automaticProcess(
	handler: Parameters<ReturnType<typeof createWorkerProcessBuilder>["turn"]>[1],
): ResolvedWorkerProcess {
	const builder = createWorkerProcessBuilder();
	builder.start("run");
	builder.turn("run", handler);
	const definition = builder.getDefinition();
	return {
		processId: "test_process",
		startTurnId: "run",
		turns: new Map([
			[
				"run",
				{
					definition: {
						id: "run",
						kind: "automatic",
						description: "Run automatically",
					} as never,
				},
			],
		]),
		definition,
		params: {},
		state: {},
	};
}

const scheduler = {
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	sleep: (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
	now: () => new Date(),
};

function execute(
	process: ResolvedWorkerProcess,
	integrationTools: Parameters<typeof executeSelectedTurn>[0]["integrationTools"] = [],
	sessionOverrides: Partial<PreparedAutomaticSession> = {},
	emit: WorkerOperationEmitter = () => {},
) {
	const session = {
		resolvedWorkerProcess: process,
		processSnapshot: createTestProcessInstance({
			id: "proc_1",
			processId: "test_process",
			selectedTurnId: "run",
			currentExecution: { kind: "worker_start", id: "start_1" },
			paramsJson: "{}",
			stateJson: "{}",
		}),
		projectSnapshots: [],
		kind: "automatic",
		selectedTurnId: "run",
		startRecordId: "start_1",
		proposedTurnRecordId: "turn_1",
		acceptedTurnRecordId: "turn_1",
		treeFile: "/tmp/tree.jsonl",
		workspaceRoot: "/tmp/workspace",
		activeModelProfileId: null,
		piAvailable: false,
		settings: {
			heartbeatIntervalMs: 30_000,
			turnMaxDurationMs: 30_000,
			turnInactivityTimeoutMs: 10_000,
			turnAbortGracePeriodMs: 1_000,
		},
	} as PreparedAutomaticSession;
	return executeSelectedTurn({
		session: { ...session, ...sessionOverrides },
		piHandle: null,
		turnRecordId: "turn_1",
		targetedInputs: [],
		scheduler,
		resultImageTools: { create: () => null },
		integrationTools,
		signal: new AbortController().signal,
		emit,
	});
}

describe("executeSelectedTurn", () => {
	it("distinguishes supplied product versions from products actually read", async () => {
		const emitted: WorkerOperationEmission[] = [];
		const product = {
			name: "plan",
			producerTurnRecordId: "producer-v1",
			entryId: "entry-v1",
			content: { state: "recorded" as const, value: "Version one" },
		};
		const result = await execute(
			automaticProcess(async (run) => {
				expect(run.ctx.turnResultMarkdownByProduct?.plan).toBe("Version one");
				expect(run.ctx.turnResultMarkdownByProduct?.plan).toBe("Version one");
				await run.complete({ outcome: "done", params: {} });
			}),
			[],
			{
				turnResultMarkdownByProduct: { plan: "Version one", unused: "Also supplied" },
				inspectionProducts: [product, { ...product, name: "unused" }],
			},
			(event) => emitted.push(event),
		);
		expect(result.kind).toBe("outcome");
		const observations = emitted.flatMap((event) =>
			event.kind === "inspection" ? [event.capture] : [],
		);
		expect(observations.map((item) => item.fact)).toEqual([
			{
				kind: "supplied_context",
				origin: null,
				products: [product, { ...product, name: "unused" }],
			},
			{ kind: "product_consumed", supplyId: observations[0].id, name: "plan" },
		]);
	});
	it("allows automatic turns to invoke authorized integration tools", async () => {
		const calls: Array<{ args: Record<string, unknown>; toolCallId: string | undefined }> = [];
		const result = await execute(
			automaticProcess(async (run) => {
				const value = await run.ctx.callIntegrationTool?.("provider_echo", { value: 2 });
				await run.complete({ outcome: "done", params: { value } });
			}),
			[
				{
					name: "provider_echo",
					description: "Echo",
					parameters: {},
					async execute(args, context) {
						calls.push({ args, toolCallId: context?.toolCallId });
						return 2;
					},
				},
			],
		);

		expect(calls).toEqual([{ args: { value: 2 }, toolCallId: "turn_1:1:provider_echo" }]);
		expect(result).toMatchObject({ kind: "outcome", params: { value: 2 } });
	});

	it("returns an automatic turn outcome directly", async () => {
		const result = await execute(
			automaticProcess(async (run) => {
				await run.complete({ outcome: "done", params: { value: 1 }, markdown: "Done" });
			}),
		);

		expect(result).toMatchObject({
			kind: "outcome",
			turnId: "run",
			outcome: "done",
			params: { value: 1 },
			meta: { turnRecordId: "turn_1", turnType: "automatic", pathType: "primary" },
		});
	});

	it("returns a failed terminal fact when an automatic handler does not complete", async () => {
		const result = await execute(automaticProcess(async () => {}));

		expect(result).toMatchObject({
			kind: "failed",
			failure: {
				turnRecordId: "turn_1",
				turnId: "run",
				turnType: "automatic",
				pathType: "primary",
				failure: { errorClass: "protocol_error" },
			},
		});
	});

	it("returns a parked terminal fact", async () => {
		const result = await execute(
			automaticProcess(async (run) => {
				run.park("waiting");
			}),
		);

		expect(result).toEqual({
			kind: "parked",
			reason: "waiting",
			appliedTargetedInputs: [],
		});
	});
});
