import { describe, expect, it } from "vitest";
import { flow, type LlmFlowBuilder } from "./flow.js";

describe("flow", () => {
	it.each([
		"llm",
		"automatic",
		"human",
		"external",
	] as const)("preserves %s builder identity and fluent descriptions", (kind) => {
		const turn = flow[kind]("example");
		expect(turn.id).toBe("example");
		expect(turn.description("First description")).toBe(turn);
		expect(turn.description("Updated description")).toBe(turn);
	});

	it("builds a discoverable plan-producing LLM turn", async () => {
		const turn = flow
			.llm<{ prompt: string }, Record<string, never>>("generate_plan")
			.description("Draft plan")
			.tools("read", "grep")
			.freshPrimary()
			.prompt((ctx) => `Plan ${ctx.params.prompt}`)
			.producesPlan((plan) => plan.summary().acceptanceCriteria().review("plan_decision"));

		expect(turn.id).toBe("generate_plan");
		expect(turn.definition).toMatchObject({
			kind: "llm",
			description: "Draft plan",
			availableTools: ["read", "grep"],
			completionMode: "turn_end",
			branchType: "primary",
			context: "fresh",
			resultSemanticRef: "plan",
		});
		expect(await turn.definition.prompt({ params: { prompt: "change" } } as never)).toBe(
			"Plan change",
		);
		expect(turn.definition.outcomes?.plan_saved).toMatchObject({
			to: "plan_decision",
			parameters: {
				summary: { type: "string", required: true },
				acceptanceCriteria: { type: "array", required: true, minItems: 1 },
			},
			lifecycleIntent: {
				kind: "save_plan_result",
				emitEventType: "plan_saved",
				broadcastType: "plan.updated",
			},
		});
	});

	it("fails fast when a plan result is incomplete", () => {
		expect(() =>
			flow
				.llm("generate_plan")
				.description("Draft plan")
				.prompt(() => "Plan")
				.producesPlan((plan) => plan.summary().review("plan_decision")),
		).toThrow(/acceptanceCriteria/);
	});

	it.each([
		[
			"the session root",
			(turn: LlmFlowBuilder) => turn.fullPrimary().startFromRoot(),
			{ startFrom: { kind: "session_root" } },
		],
		[
			"the review branch",
			(turn: LlmFlowBuilder) => turn.fullPrimary().continueFromReviewBranch(),
			{ startFrom: { kind: "semantic_ref", ref: "review", fallback: { kind: "current_leaf" } } },
		],
		[
			"a product branch with a fresh seed",
			(turn: LlmFlowBuilder) =>
				turn.freshSeededPrimary().continueFromProductBranch("simplification-plan", {
					kind: "session_root",
				}),
			{
				context: "fresh_seeded",
				startFrom: {
					kind: "product_ref",
					productName: "simplification-plan",
					fallback: { kind: "session_root" },
				},
			},
		],
		[
			"a product branch with a nested fallback",
			(turn: LlmFlowBuilder) =>
				turn.fullPrimary().continueFromProductBranch("simplification-plan", {
					kind: "semantic_ref",
					ref: "review",
					fallback: { kind: "current_leaf" },
				}),
			{
				startFrom: {
					kind: "product_ref",
					productName: "simplification-plan",
					fallback: { kind: "semantic_ref", ref: "review", fallback: { kind: "current_leaf" } },
				},
			},
		],
	] as const)("builds primary turns starting from %s", (_name, configure, expected) => {
		const turn = configure(
			flow
				.llm("implement")
				.description("Implement")
				.prompt(() => "Implement"),
		).end("done").definition;

		expect(turn).toMatchObject({ kind: "llm", branchType: "primary", ...expected });
	});

	it("builds .end() turns without publishing a product", () => {
		const completion = flow
			.llm("run_prompt")
			.description("Run prompt")
			.prompt(() => "Prompt")
			.end("completed")
			.complete();
		const turn = completion.definition;
		const target = completion.buildRouteTarget();
		target.complete = false;
		expect(completion.buildRouteTarget()).toEqual({ complete: true });
		expect(() => completion.to("next")).toThrow(/already declares a target/);

		expect(turn).toMatchObject({
			kind: "llm",
			turnResultMarkdown: { mode: "assistant_output", required: true },
			turnEnd: { outcome: "completed", complete: true },
		});
		expect(turn.publishedProduct).toBeUndefined();
	});

	it("builds product-reviewed human turns without exposing semantic refs in the DSL", () => {
		const turn = flow
			.human("review_feedback")
			.description("Review feedback")
			.reviewProduct("review")
			.reviewProduct("message")
			.action("accept", (action) =>
				action.label("Accept").acceptanceState("accepted").to("next"),
			).definition;

		expect(turn).toMatchObject({
			kind: "human",
			reviewProduct: "message",
		});
		expect(turn.reviewSemanticRef).toBeUndefined();
	});

	it("builds generic human turns without review metadata", () => {
		const turn = flow
			.human("command_console")
			.description("Command console")
			.operatorAttention("passive")
			.action("run_command", (action) =>
				action.label("Run command").acceptanceState("neutral").to("command_console"),
			).definition;

		expect(turn).toMatchObject({
			kind: "human",
			operatorAttention: "passive",
			actions: { run_command: { to: "command_console" } },
		});
		expect(turn.reviewProduct).toBeUndefined();
	});

	it("marks published outcome markdown fields as required product publishers", () => {
		const turn = flow
			.llm("review")
			.description("Review")
			.prompt(() => "Review")
			.outcomeTool("leave_feedback", (tool) =>
				tool
					.description("Leave feedback")
					.markdown("message", { description: "Feedback", publish: true })
					.to("human_review"),
			).definition;

		expect(turn.turnResultMarkdown).toBeUndefined();
		expect(turn.outcomes?.leave_feedback).toMatchObject({
			publishedProduct: "message",
			turnResultMarkdownParameter: "message",
			parameters: { message: { type: "string", required: true } },
		});
	});

	it("builds state-routed LLM outcomes with one model-facing tool", () => {
		const turn = flow
			.llm<unknown, { automatic: boolean }>("implement")
			.description("Implement")
			.prompt(() => "Implement")
			.outcomeTool("ready", (tool) =>
				tool
					.description("Implementation is ready")
					.markdown("summary", { publish: true })
					.routeByState({ manual: "decision", automatic: "deliver" }, ({ ctx }) =>
						ctx.state.automatic ? "automatic" : "manual",
					),
			).definition;

		expect(Object.keys(turn.outcomes ?? {})).toEqual(["ready"]);
		expect(turn.outcomes?.ready).toMatchObject({
			branches: {
				manual: { to: "decision" },
				automatic: { to: "deliver" },
			},
		});
	});

	it("builds concise human and external flow turns", () => {
		const human = flow
			.human("review")
			.description("Review")
			.operatorAttention("passive")
			.action("approve", (action) =>
				action.label("Approve").acceptanceState("accepted").complete(),
			).definition;
		const route = flow
			.external("await_file")
			.description("Await file")
			.from({ kind: "example.file", label: "Example file", config: { path: "/tmp/file" } })
			.to("review");
		const external = route.definition;

		expect(human).toMatchObject({
			operatorAttention: "passive",
			actions: {
				approve: {
					label: "Approve",
					acceptanceState: "accepted",
					complete: true,
				},
			},
		});
		expect(external).toMatchObject({
			kind: "external",
			transitions: [
				{
					source: { kind: "example.file" },
					to: "review",
				},
			],
		});
		external.transitions[0].to = "mutated";
		expect(route.definition.transitions[0].to).toBe("review");
		expect(() => route.complete()).toThrow(/already declares a target/);
	});
});
