import {
	createTestProcessInstance,
	createTestProcessProject,
	createTestWorkerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import { emptyParamsCodec } from "./codecs.js";
import { flow } from "./flow.js";

const stateCodec = { parse: () => ({}), serialize: (value: Record<string, never>) => value };
const fileSource = {
	kind: "example.file.instruction",
	config: {},
	inputMode: "instruction" as const,
};

function llmTurn<TParams = unknown, TState = unknown>(id: string) {
	return flow.llm<TParams, TState>(id).description(id);
}

function inputPublishingReview(target?: string) {
	return flow
		.human("review")
		.description("Review")
		.action("complete", (action) => action.label("Complete").acceptanceState("accepted").complete())
		.externalAction("review_file", fileSource, (external) => {
			const published = external.publishInput("message", { inputField: "instruction" });
			return target ? published.to(target) : published.complete();
		});
}

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
		const turn = llmTurn<{ prompt: string }, Record<string, never>>("implement")
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
		const turn = llmTurn<{ prompt: string }, Record<string, never>>("draft")
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
		const turn = llmTurn<{ prompt: string }, Record<string, never>>("review")
			.consume("implementation-summary")
			.outcomeTool("done", (tool) => tool.description("Done").complete())
			.buildPrompt((ctx) => ctx.input["implementation-summary"]);

		expect(
			await turn.definition.prompt(workerCtx({ "implementation-summary": "## Implementation" })),
		).toBe("## Implementation");
	});

	it("rejects missing or blank markdown when a product is required and optional", () => {
		const turn = llmTurn<{ prompt: string }, Record<string, never>>("implement")
			.consume("plan")
			.optionalConsume("plan")
			.outcomeTool("done", (tool) => tool.description("Done").complete())
			.buildPrompt((ctx) => ctx.input.plan);

		expect(() => turn.definition.prompt(workerCtx())).toThrow(/requires product 'plan'/);
		expect(() => turn.definition.prompt(workerCtx({ plan: " " }))).toThrow(
			/requires product 'plan'/,
		);
	});

	it("compiles review publication to required markdown and compatibility semantic ref", () => {
		const turn = llmTurn("review")
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
		const turn = llmTurn("review")
			.buildPrompt(() => "Review")
			.outcomeTool("request_changes", (tool) =>
				tool.description("Request changes").markdown("review", { publish: true }).complete(),
			);

		expect(turn.definition.resultSemanticRef).toBe("review");
		expect(turn.definition.outcomes?.request_changes?.publishedProduct).toBe("review");
	});

	it.each([
		["plan", "plan"],
		["implementation-summary", undefined],
	] as const)("compiles routed %s publication to a deterministic turnEnd", (productName, semanticRef) => {
		const turn = llmTurn("publish")
			.buildPrompt(() => "Result")
			.publish(productName)
			.to("decision").definition;

		expect(turn.publishedProduct).toBe(productName);
		expect(turn.resultSemanticRef).toBe(semanticRef);
		expect(turn.outcomes).toBeUndefined();
		expect(turn.turnEnd).toMatchObject({ outcome: productName, to: "decision" });
	});

	it("rejects routed publication plus explicit outcome tools in flow v1", () => {
		const turn = llmTurn("ambiguous")
			.buildPrompt(() => "Prompt")
			.outcomeTool("done", (tool) => tool.description("Done").complete())
			.publish("implementation-summary")
			.to("next");

		expect(() => turn.definition).toThrow(/cannot route published product/);
	});

	it("rejects publication with no route and no outcome tools", () => {
		const turn = llmTurn("stuck")
			.buildPrompt(() => "Prompt")
			.publish("review");

		expect(() => turn.definition).toThrow(/declares no route or outcome tool/);
	});

	it("rejects .end() and outcome tools after publication", () => {
		const builder = llmTurn("published").buildPrompt(() => "Prompt");
		builder.publish("result").to("next");

		expect(() => builder.end("done")).toThrow(/both \.publish\(\.\.\.\) and \.end/);
		expect(() =>
			builder.outcomeTool("done", (tool) => tool.description("Done").complete()),
		).toThrow(/outcome tools after \.publish/);
	});

	it("rejects outcome tool parameters that collide with generated markdown", () => {
		const turn = llmTurn("bad_markdown_param")
			.buildPrompt(() => "Prompt")
			.outcomeTool("done", (tool) =>
				tool.description("Done").requiredString("markdown", "Markdown").complete(),
			);

		expect(() => turn.definition).toThrow(/reserved markdown parameter/);
	});

	it("compiles outcome parameter shorthands", () => {
		const turn = llmTurn("classify")
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
		const turn = llmTurn<unknown, { value: string }>("commit")
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
		const review = inputPublishingReview("draft");
		const draft = llmTurn("draft")
			.waitFor(({ state }) => !!state)
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
		const base = () =>
			flow
				.process("test_process")
				.displayName("Test")
				.entry("review")
				.codecs({ params: emptyParamsCodec, state: stateCodec })
				.initialState(() => ({}));

		expect(() => base().turn(inputPublishingReview()).define()).toThrow(
			/external action 'review_file' cannot publish input on a terminal route/,
		);

		expect(() =>
			base()
				.turn(inputPublishingReview("next_human"))
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
		const consumer = llmTurn("consumer")
			.consume("plan")
			.outcomeTool("done", (tool) => tool.description("Done").complete())
			.buildPrompt((ctx) => ctx.input.plan);

		const process = flow
			.process("test_process")
			.displayName("Test")
			.entry("consumer")
			.codecs({ params: emptyParamsCodec, state: stateCodec })
			.initialState(() => ({}))
			.turn(consumer);
		expect(() => process.define()).toThrow(/consumes product 'plan' that is never published/);
		process.turn(
			flow
				.automatic("publisher")
				.description("Publish plan")
				.run(() => ({ outcome: "done", params: { plan: "Plan" } }))
				.outcome("done", (outcome) =>
					outcome.description("Done").markdown("plan", { publish: true }).to("consumer"),
				),
		);
		expect(() => process.define()).not.toThrow();
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
