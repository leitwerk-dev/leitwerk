import {
	createTestProcessInstance,
	createTestProcessProject,
	createTestWorkerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import { emptyParamsCodec } from "./codecs.js";
import { flow } from "./flow.js";

const stateCodec = { parse: () => ({}), serialize: (value: Record<string, never>) => value };

function workerCtx(products: Record<string, string> = {}) {
	return createTestWorkerProcessContext({
		process: createTestProcessInstance({ processId: "test_process" }),
		projects: [createTestProcessProject({ key: "repo", workBranch: "feature/test" })],
		params: { prompt: "Initial prompt" },
		state: {},
		turnResultMarkdownByProduct: products,
	});
}

describe("flow product publication and consumption", () => {
	it("compiles consumed product metadata and hydrates prompt input", async () => {
		const turn = flow
			.llm<{ prompt: string }, Record<string, never>>("implement")
			.description("Implement")
			.tools("read")
			.fullPrimary()
			.consume("plan")
			.buildPrompt((ctx) => ctx.input.plan)
			.publish("implementation-summary")
			.to("decision");

		expect(turn.definition.consumedProducts).toEqual(["plan"]);
		expect(await turn.definition.prompt(workerCtx({ plan: "## Plan" }))).toBe("## Plan");
	});

	it("does not require a project unless the prompt asks for one", async () => {
		const turn = flow
			.llm<{ prompt: string }, Record<string, never>>("draft")
			.description("Draft")
			.outcomeTool("done", (tool) => tool.description("Done").complete())
			.buildPrompt((ctx) => ctx.prompts.initial);

		expect(
			await turn.definition.prompt(
				createTestWorkerProcessContext({
					process: createTestProcessInstance({ processId: "test_process" }),
					projects: [],
					params: { prompt: "Initial prompt" },
					state: {},
				}),
			),
		).toBe("Initial prompt");
	});

	it("hydrates hyphenated product names through bracket access", async () => {
		const turn = flow
			.llm<{ prompt: string }, Record<string, never>>("review")
			.description("Review")
			.consume("implementation-summary")
			.outcomeTool("done", (tool) => tool.description("Done").complete())
			.buildPrompt((ctx) => ctx.input["implementation-summary"]);

		expect(
			await turn.definition.prompt(workerCtx({ "implementation-summary": "## Implementation" })),
		).toBe("## Implementation");
	});

	it("fails fast when required product markdown is missing from the worker payload", async () => {
		const turn = flow
			.llm<{ prompt: string }, Record<string, never>>("implement")
			.description("Implement")
			.consume("plan")
			.outcomeTool("done", (tool) => tool.description("Done").complete())
			.buildPrompt((ctx) => ctx.input.plan);

		expect(() => turn.definition.prompt(workerCtx())).toThrow(/requires product 'plan'/);
	});

	it("compiles review publication to required markdown and compatibility semantic ref", () => {
		const turn = flow
			.llm("review")
			.description("Review")
			.buildPrompt(() => "Review")
			.outcomeTool("no_issues", (tool) => tool.description("No issues").complete())
			.publish("review");

		expect(turn.definition).toMatchObject({
			publishedProduct: "review",
			resultSemanticRef: "review",
			turnResultMarkdown: {
				mode: "outcome_tool_argument",
				parameterName: "markdown",
				required: true,
			},
		});
	});

	it("derives the review semantic ref from an outcome-published review product", () => {
		const turn = flow
			.llm("review")
			.description("Review")
			.buildPrompt(() => "Review")
			.outcomeTool("request_changes", (tool) =>
				tool.description("Request changes").markdown("review", { publish: true }).complete(),
			);

		expect(turn.definition.resultSemanticRef).toBe("review");
		expect(turn.definition.outcomes?.request_changes?.publishedProduct).toBe("review");
	});

	it("compiles plan publication as a generic product publication", () => {
		const turn = flow
			.llm("generate_plan")
			.description("Draft plan")
			.buildPrompt(() => "Plan")
			.publish("plan")
			.to("plan_decision");

		expect(turn.definition.publishedProduct).toBe("plan");
		expect(turn.definition.resultSemanticRef).toBe("plan");
		expect(turn.definition.outcomes).toBeUndefined();
		expect(turn.definition.turnEnd).toMatchObject({
			outcome: "plan",
			to: "plan_decision",
		});
	});

	it("compiles routed generic publication to a deterministic turnEnd outcome", () => {
		const turn = flow
			.llm("implement")
			.description("Implement")
			.buildPrompt(() => "Implement")
			.publish("implementation-summary")
			.to("implementation_decision");

		expect(turn.definition.outcomes).toBeUndefined();
		expect(turn.definition.turnEnd).toMatchObject({
			outcome: "implementation-summary",
			to: "implementation_decision",
		});
	});

	it("rejects routed publication plus explicit outcome tools in flow v1", () => {
		const turn = flow
			.llm("ambiguous")
			.description("Ambiguous")
			.buildPrompt(() => "Prompt")
			.outcomeTool("done", (tool) => tool.description("Done").complete())
			.publish("implementation-summary")
			.to("next");

		expect(() => turn.definition).toThrow(/cannot route published product/);
	});

	it("rejects publication with no route and no outcome tools", () => {
		const turn = flow
			.llm("stuck")
			.description("Stuck")
			.buildPrompt(() => "Prompt")
			.publish("review");

		expect(() => turn.definition).toThrow(/declares no route or outcome tool/);
	});

	it("rejects .end() and outcome tools after publication", () => {
		const builder = flow
			.llm("published")
			.description("Published")
			.buildPrompt(() => "Prompt");
		builder.publish("result").to("next");

		expect(() => builder.end("done")).toThrow(/both \.publish\(\.\.\.\) and \.end/);
		expect(() =>
			builder.outcomeTool("done", (tool) => tool.description("Done").complete()),
		).toThrow(/outcome tools after \.publish/);
	});

	it("rejects outcome tool parameters that collide with generated markdown", () => {
		const turn = flow
			.llm("bad_markdown_param")
			.description("Bad")
			.buildPrompt(() => "Prompt")
			.outcomeTool("done", (tool) =>
				tool.description("Done").requiredString("markdown", "Markdown").complete(),
			);

		expect(() => turn.definition).toThrow(/reserved markdown parameter/);
	});

	it("compiles outcome parameter shorthands", () => {
		const turn = flow
			.llm("classify")
			.description("Classify")
			.buildPrompt(() => "Classify")
			.outcomeTool("classified", (tool) =>
				tool
					.description("Classified")
					.requiredString("summary", "Summary")
					.requiredNumber("score", "Confidence")
					.requiredBoolean("safe", "Whether the output is safe")
					.requiredStringArray("tags", "Tags")
					.enum("severity", ["low", "high"])
					.object("metadata", "Extra metadata")
					.complete(),
			);

		expect(turn.definition.outcomes?.classified.parameters).toMatchObject({
			summary: { type: "string", required: true, requiredErrorCode: "summary_required" },
			score: { type: "number", required: true, requiredErrorCode: "score_required" },
			safe: { type: "boolean", required: true, requiredErrorCode: "safe_required" },
			tags: { type: "array", required: true, items: { type: "string" } },
			severity: { type: "string", enum: ["low", "high"] },
			metadata: { type: "object" },
		});
	});

	it("compiles outcome parameters and state effects", async () => {
		const turn = flow
			.llm<unknown, { value: string }>("commit")
			.description("Commit")
			.buildPrompt(() => "Commit")
			.outcomeTool("committed", (tool) =>
				tool
					.description("Committed")
					.requiredString("headSha", "The post-commit HEAD sha")
					.boolean("amended", "Whether the commit amended HEAD")
					.to("next")
					.state(({ ctx, event }) => ({
						value: `${ctx.output?.content ?? ""}:${event.params.headSha}`,
					})),
			);

		const outcome = turn.definition.outcomes?.committed;
		expect(outcome?.parameters.headSha).toMatchObject({
			type: "string",
			required: true,
			requiredErrorCode: "head_sha_required",
		});
		expect(outcome?.parameters.amended).toMatchObject({ type: "boolean" });
		const effect = await outcome?.effect?.({
			ctx: {
				process: createTestProcessInstance(),
				projects: [],
				params: {},
				state: { value: "old" },
				readSemanticTurnResultMarkdown: () => null,
				readProductTurnResultMarkdown: () => null,
			},
			event: {
				turnRecordId: "trn_1",
				turnId: "commit",
				outcome: "committed",
				params: { headSha: "abc123" },
				turnResultMarkdown: "## Commit",
			},
			turnId: "commit",
			outcome: "committed",
		});
		expect(effect).toEqual({ state: { value: "## Commit:abc123" } });
	});

	it("allows selected-turn external actions to publish input consumed by their target LLM", () => {
		const source = {
			kind: "example.file.instruction",
			config: {},
			inputMode: "instruction" as const,
		};
		const review = flow
			.human("review")
			.description("Review")
			.action("complete", (action) =>
				action.label("Complete").acceptanceState("accepted").complete(),
			)
			.externalAction("review_file", source, (external) =>
				external.publishInput("message", { inputField: "instruction" }).to("draft"),
			);
		const draft = flow
			.llm("draft")
			.description("Draft")
			.optionalConsume("message")
			.buildPrompt((ctx) => ctx.input.message ?? "initial")
			.end("done")
			.to("review");

		const process = flow
			.process("test_process")
			.displayName("Test")
			.entry("review")
			.codecs({ params: emptyParamsCodec, state: stateCodec })
			.initialState(() => ({}))
			.turn(review)
			.turn(draft)
			.define();

		const reviewTurn = process.turns.get("review")?.definition;
		expect(reviewTurn?.kind).toBe("human");
		if (reviewTurn?.kind !== "human") {
			throw new Error("expected human turn");
		}
		expect(reviewTurn.externalActions?.review_file).toMatchObject({
			id: "review_file",
			publishInput: { productName: "message", inputField: "instruction" },
			to: "draft",
		});
	});

	it("rejects external input publication to terminal or non-consuming targets", () => {
		const source = {
			kind: "example.file.instruction",
			config: {},
			inputMode: "instruction" as const,
		};
		const base = () =>
			flow
				.process("test_process")
				.displayName("Test")
				.entry("review")
				.codecs({ params: emptyParamsCodec, state: stateCodec })
				.initialState(() => ({}));

		expect(() =>
			base()
				.turn(
					flow
						.human("review")
						.description("Review")
						.action("complete", (action) =>
							action.label("Complete").acceptanceState("accepted").complete(),
						)
						.externalAction("review_file", source, (external) =>
							external.publishInput("message", { inputField: "instruction" }).complete(),
						),
				)
				.define(),
		).toThrow(/publishes input 'message' but does not route to a consuming turn/);

		expect(() =>
			base()
				.turn(
					flow
						.human("review")
						.description("Review")
						.action("complete", (action) =>
							action.label("Complete").acceptanceState("accepted").complete(),
						)
						.externalAction("review_file", source, (external) =>
							external.publishInput("message", { inputField: "instruction" }).to("next_human"),
						),
				)
				.turn(
					flow
						.human("next_human")
						.description("Next")
						.action("complete", (action) =>
							action.label("Complete").acceptanceState("accepted").complete(),
						),
				)
				.define(),
		).toThrow(/target turn 'next_human' is not an LLM turn/);
	});

	it("validates consumed products against process publications", () => {
		const consumer = flow
			.llm("consumer")
			.description("Consumer")
			.consume("plan")
			.outcomeTool("done", (tool) => tool.description("Done").complete())
			.buildPrompt((ctx) => ctx.input.plan);

		expect(() =>
			flow
				.process("test_process")
				.displayName("Test")
				.entry("consumer")
				.codecs({ params: emptyParamsCodec, state: stateCodec })
				.initialState(() => ({}))
				.turn(consumer)
				.define(),
		).toThrow(/consumes product 'plan' that is never published/);
	});

	it("rejects invalid product names early", () => {
		expect(() => flow.llm("bad").consume("Implementation Summary")).toThrow(
			/Invalid process product name/,
		);
		expect(() => flow.llm("bad").publish("implementation_summary")).toThrow(
			/Invalid process product name/,
		);
	});
});
