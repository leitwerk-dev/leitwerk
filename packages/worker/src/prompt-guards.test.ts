import { createManualWorkerRuntimeScheduler } from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it } from "vitest";
import type { WorkerOperationEmission } from "./diagnostics.js";
import { OperatorAbortError, PromptGuardSuspension, promptWithGuards } from "./prompt-guards.js";

function createMinimalPiHandle(abortBehavior: "complete" | "reject" | "pending" = "complete") {
	let abortCount = 0;
	return {
		get abortCount() {
			return abortCount;
		},
		subscribe() {
			return () => {};
		},
		async abortTurn() {
			abortCount += 1;
			if (abortBehavior === "reject") throw new Error("Abort failed");
			if (abortBehavior === "pending") await new Promise(() => {});
		},
	};
}

describe("promptWithGuards", () => {
	it("does not start a prompt when the operator abort signal is already fired", async () => {
		const controller = new AbortController();
		controller.abort();
		const piHandle = createMinimalPiHandle();
		let promptStarted = false;

		await expect(
			promptWithGuards(
				{
					scheduler: createManualWorkerRuntimeScheduler(),
					operatorAbortSignal: controller.signal,
				},
				{
					piHandle,
					turnRecordId: "trn_pre_aborted",
					turnId: "implement",
					runPrompt: async () => {
						promptStarted = true;
						return {
							startLeafId: null,
							endLeafId: null,
							createdEntryIds: [],
							resultEntryId: "unexpected",
						};
					},
				},
			),
		).rejects.toBeInstanceOf(OperatorAbortError);

		expect(promptStarted).toBe(false);
		expect(piHandle.abortCount).toBe(1);
	});

	it.each([
		"complete",
		"reject",
		"pending",
	] as const)("preserves the timeout when abort behavior is %s", async (abortBehavior) => {
		const scheduler = createManualWorkerRuntimeScheduler();
		const piHandle = createMinimalPiHandle(abortBehavior);
		const emissions: WorkerOperationEmission[] = [];
		const prompt = promptWithGuards(
			{
				scheduler,
				turnMaxDurationMs: 250,
				turnAbortGracePeriodMs: 10,
				emit: (event) => emissions.push(event),
			},
			{
				piHandle,
				turnRecordId: "trn_timeout",
				turnId: "implement",
				runPrompt: () => new Promise(() => {}),
			},
		);

		await scheduler.advanceBy(249);
		expect(piHandle.abortCount).toBe(0);
		await scheduler.advanceBy(1);
		await expect(prompt).rejects.toMatchObject({ timeoutKind: "max_duration", timeoutMs: 250 });
		expect(piHandle.abortCount).toBe(1);
		await scheduler.advanceBy(10);
		expect(
			emissions.filter((event) => event.kind === "error").map((event) => event.payload.code),
		).toEqual([
			"guard.turn_max_duration_exceeded",
			...(abortBehavior === "complete"
				? []
				: [abortBehavior === "reject" ? "guard.abort_failed" : "guard.abort_grace_elapsed"]),
		]);
	});

	it("pauses maximum-duration and inactivity budgets while awaiting operator input", async () => {
		const scheduler = createManualWorkerRuntimeScheduler();
		const piHandle = createMinimalPiHandle();
		const guardSuspension = new PromptGuardSuspension();
		const prompt = promptWithGuards(
			{
				scheduler,
				turnMaxDurationMs: 100,
				turnInactivityTimeoutMs: 60,
				guardSuspension,
			},
			{
				piHandle,
				turnRecordId: "trn_questions",
				turnId: "plan",
				runPrompt: () => new Promise(() => {}),
			},
		);

		await scheduler.advanceBy(40);
		const resume = guardSuspension.suspend();
		await scheduler.advanceBy(1_000);
		expect(piHandle.abortCount).toBe(0);

		resume();
		await scheduler.advanceBy(59);
		expect(piHandle.abortCount).toBe(0);
		await scheduler.advanceBy(1);
		await expect(prompt).rejects.toMatchObject({ timeoutKind: "max_duration", timeoutMs: 100 });
		expect(piHandle.abortCount).toBe(1);
	});
});
