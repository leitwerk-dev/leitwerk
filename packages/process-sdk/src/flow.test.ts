import { describe, expect, it } from "vitest";
import { flow } from "./flow.js";

describe("flow", () => {
	it("declares server-owned integration tools on an LLM turn", () => {
		const turn = flow
			.llm("repair")
			.description("Repair a provider failure")
			.integrationTools("forgejo_get_pull_request", "woodpecker_get_step_logs")
			.prompt(() => "Diagnose the current failure")
			.end("done").definition;

		expect(turn).toMatchObject({
			kind: "llm",
			integrationTools: ["forgejo_get_pull_request", "woodpecker_get_step_logs"],
		});
	});

	it("builds a discoverable plan-producing LLM turn", async () => {
		const turn = flow
			.llm<{ prompt: string }, { reviewSubject: null }>("generate_plan")
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
			description: "The candidate plan is ready for operator review",
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

	it("builds turns that start with no persisted Pi ancestry", () => {
		const turn = flow
			.llm("commit")
			.description("Commit")
			.fullPrimary()
			.startFromRoot()
			.prompt(() => "Commit the change")
			.end("done").definition;

		expect(turn).toMatchObject({
			kind: "llm",
			branchType: "primary",
			startFrom: { kind: "session_root" },
		});
	});

	it("builds primary turns that continue from the review branch", () => {
		const turn = flow
			.llm("implement")
			.description("Implement")
			.fullPrimary()
			.continueFromReviewBranch()
			.prompt(() => "Implement from accepted review")
			.end("done").definition;

		expect(turn).toMatchObject({
			kind: "llm",
			branchType: "primary",
			startFrom: {
				kind: "semantic_ref",
				ref: "review",
				fallback: { kind: "current_leaf" },
			},
		});
	});

	it("builds fresh-seeded primary turns for optional side-branch handoffs", () => {
		const turn = flow
			.llm("implement")
			.description("Implement")
			.freshSeededPrimary()
			.continueFromProductBranch("simplification-plan", { kind: "session_root" })
			.prompt(() => "Implement from a small seed when present")
			.end("done").definition;

		expect(turn).toMatchObject({
			kind: "llm",
			branchType: "primary",
			context: "fresh_seeded",
			startFrom: {
				kind: "product_ref",
				productName: "simplification-plan",
				fallback: { kind: "session_root" },
			},
		});
	});

	it("builds primary turns that continue from a product branch with fallback", () => {
		const turn = flow
			.llm("implement")
			.description("Implement")
			.fullPrimary()
			.continueFromProductBranch("simplification-plan", {
				kind: "semantic_ref",
				ref: "review",
				fallback: { kind: "current_leaf" },
			})
			.prompt(() => "Implement from accepted side branch")
			.end("done").definition;

		expect(turn).toMatchObject({
			kind: "llm",
			branchType: "primary",
			startFrom: {
				kind: "product_ref",
				productName: "simplification-plan",
				fallback: {
					kind: "semantic_ref",
					ref: "review",
					fallback: { kind: "current_leaf" },
				},
			},
		});
	});

	it("builds .end() turns without publishing a product", () => {
		const turn = flow
			.llm("run_prompt")
			.description("Run prompt")
			.prompt(() => "Prompt")
			.end("completed")
			.complete().definition;

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
			.reviewProduct("message", { subject: "implementation" })
			.action("accept", (action) =>
				action.label("Accept").acceptanceState("accepted").to("next"),
			).definition;

		expect(turn).toMatchObject({
			kind: "human",
			reviewProduct: "message",
			reviewSubject: { kind: "implementation" },
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
		expect(turn.reviewSubject).toBeUndefined();
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

	it("builds concise human, server-automatic, and external flow turns", () => {
		const human = flow
			.human("review")
			.description("Review")
			.review("plan")
			.operatorAttention("passive")
			.action("approve", (action) =>
				action.label("Approve").acceptanceState("accepted").complete(),
			).definition;
		const serverAutomatic = flow
			.serverAutomatic("check_ready")
			.description("Check readiness")
			.restartBehavior("fail_running")
			.outcome("ready", (outcome) => outcome.description("Ready").to("review"))
			.run(() => ({ outcome: "ready", params: {} })).definition;
		const external = flow
			.external("await_file")
			.description("Await file")
			.from({ kind: "example.file", label: "Example file", config: { path: "/tmp/file" } })
			.to("review").definition;

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
		expect(serverAutomatic).toMatchObject({
			kind: "server_automatic",
			restartBehavior: "fail_running",
			outcomes: { ready: { to: "review" } },
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
	});
});
