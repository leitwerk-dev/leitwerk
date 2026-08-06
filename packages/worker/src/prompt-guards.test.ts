import { createManualWorkerRuntimeScheduler } from "@leitwerk-dev/test-support/worker-testing";
import { describe, expect, it } from "vitest";
import { OperatorAbortError, PromptGuardSuspension, promptWithGuards } from "./prompt-guards.js";

function createMinimalPiHandle() {
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

	it("uses the injected scheduler for maximum-duration timeouts", async () => {
		const scheduler = createManualWorkerRuntimeScheduler();
		const piHandle = createMinimalPiHandle();
		const prompt = promptWithGuards(
			{
				scheduler,
				turnMaxDurationMs: 250,
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
