import { createReviewSubject } from "@leitwerk-dev/domain";
import {
	buildServerProcessForTest,
	createTestProcessInstance,
	createTestServerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import { defineProcess, humanTurn } from "./define-process.js";
import { flow } from "./flow.js";

interface TestState {
	reviewSubject: { kind: "plan" } | null;
	cleared: boolean;
}

describe("flow lifecycle intents", () => {
	it("expands plan intent into state, process patch, broadcast, and event effects", async () => {
		const generatePlan = flow
			.llm<unknown, TestState>("generate_plan")
			.description("Draft plan")
			.prompt(() => "Draft a plan")
			.producesPlan((plan) =>
				plan
					.summary()
					.acceptanceCriteria()
					.review("plan_decision")
					.state(({ ctx }) => ({ ...ctx.state, cleared: true })),
			);
		const process = defineProcess<unknown, TestState>({
			id: "test_process",
			displayName: "Test",
			entry: generatePlan.id,
			paramsCodec: { parse: () => undefined, serialize: (value) => value },
			stateCodec: { parse: (value) => value as TestState, serialize: (value) => value },
			initialState: () => ({ reviewSubject: null, cleared: false }),
			turns: {
				[generatePlan.id]: generatePlan.definition,
				plan_decision: humanTurn({
					description: "Plan decision",
					reviewSubject: createReviewSubject("plan"),
					actions: {
						approve: { label: "Approve", acceptanceState: "accepted", complete: true },
					},
				}),
			},
		});
		const server = buildServerProcessForTest(process);
		const handler = server?.turnOutcomeHandlers.get("generate_plan")?.[0];
		expect(handler).toBeDefined();
		if (!handler) return;

		const transitions: unknown[] = [];
		const lifecycleEffects: unknown[] = [];
		const emitted: unknown[] = [];
		await handler(
			{
				turnRecordId: "trn_1",
				turnId: "generate_plan",
				outcome: "plan_saved",
				params: { summary: "Do it", acceptanceCriteria: ["works", "ships"] },
				turnResultMarkdown: "# Plan",
			},
			createTestServerProcessContext<unknown, TestState>({
				process: createTestProcessInstance({
					processId: "test_process",
					selectedTurnId: "generate_plan",
					planRevision: 4,
				}),
				state: { reviewSubject: null, cleared: false },
				transition: async (next) => {
					transitions.push(next);
				},
				emitEvent: (type, payload) => {
					emitted.push({ type, payload });
				},
				applyLifecycleEffects: (effects) => {
					lifecycleEffects.push(effects);
				},
			}),
		);

		expect(transitions).toEqual([
			{
				state: { reviewSubject: { kind: "plan" }, cleared: true },
			},
		]);
		expect(lifecycleEffects).toEqual([
			expect.objectContaining({
				processPatch: { planRevision: 5 },
				broadcasts: [
					expect.objectContaining({
						type: "plan.updated",
						payload: expect.objectContaining({ planRevision: 5, summary: "Do it" }),
					}),
				],
			}),
		]);
		expect(emitted).toEqual([
			{
				type: "plan_saved",
				payload: {
					planRevision: 5,
					summary: "Do it",
					planMarkdown: "# Plan",
					acceptanceCriteria: ["works", "ships"],
				},
			},
		]);
	});
});
