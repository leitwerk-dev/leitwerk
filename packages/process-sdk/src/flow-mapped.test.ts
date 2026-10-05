import { describe, expect, it, vi } from "vitest";
import type { ProcessRuntimeTurnContext } from "./define-process.js";
import type { Codec } from "./extension-api.js";
import { SafeOutcomePlanningError } from "./extension-api.js";
import { flow } from "./flow.js";
import {
	collectMappedResults,
	freezeMappedItems,
	type MappedTurnServerContext,
	yieldMappedItemResult,
} from "./mapped-turn.js";
import { getProcessTurnTransitions } from "./process-definition-internals.js";
import { validateLlmTurnDefinition } from "./turn-semantics.js";

interface Item {
	id: string;
	name: string;
}
interface Result {
	id: string;
	verdict: "keep" | "drop";
}
interface State {
	pending?: Item[];
	kept: string[];
}

const itemCodec: Codec<Item> = {
	parse(value) {
		const input = value as Partial<Item>;
		if (typeof input?.id !== "string" || typeof input.name !== "string") {
			throw new Error("Item needs id and name");
		}
		return { id: input.id, name: input.name };
	},
	serialize: (value) => value,
};

const resultCodec: Codec<Result> = {
	parse(value) {
		const input = value as Partial<Result>;
		if (typeof input?.id !== "string" || (input.verdict !== "keep" && input.verdict !== "drop")) {
			throw new Error("Invalid result");
		}
		return { id: input.id, verdict: input.verdict };
	},
	serialize: (value) => value,
};

function mappedBuilder() {
	return flow
		.mappedLlm<Record<string, never>, State, Item, Result>("review_item", {
			items: ({ state }) => state.pending,
			itemCodec,
			resultCodec,
			key: ({ item }) => item.id,
			label: ({ item }) => `Item  ${item.name}\n`,
			stateAfterSnapshot: ({ state }) => ({ ...state, pending: undefined }),
		})
		.description("Review one item")
		.freshPrimary();
}

function itemOutcomeBuilder() {
	return mappedBuilder()
		.buildPrompt(() => "Assess")
		.outcomeTool("keep", (outcome) =>
			outcome.description("Keep").yield(({ ctx }) => ({ id: ctx.item.id, verdict: "keep" })),
		);
}

function mappedTurn() {
	return mappedBuilder()
		.buildPrompt((ctx) => `Review ${ctx.item.name} (${ctx.itemIndex + 1}/${ctx.itemCount})`)
		.outcomeTool("keep", (outcome) =>
			outcome
				.description("Keep this item")
				.requiredString("reason", "Why the item stays")
				.yield(({ ctx }) => ({ id: ctx.item.id, verdict: "keep" as const })),
		)
		.outcomeTool("drop", (outcome) =>
			outcome
				.description("Drop this item")
				.yield(({ ctx }) => ({ id: ctx.item.id, verdict: "drop" as const })),
		)
		.collect(({ state }, results) => ({
			...state,
			kept: results.filter((result) => result.verdict === "keep").map((result) => result.id),
		}))
		.routeByState({ review: "review_kept", done: "deliver" }, ({ state }) =>
			state.kept.length ? "review" : "done",
		);
}

function serverContext(state: State): MappedTurnServerContext<Record<string, never>, State> {
	return { process: { id: "pi_1" } as never, projects: [], params: {}, state };
}

function iteration(key: string, itemIndex = 0, itemCount = 1) {
	return {
		runId: "run_1",
		itemKey: key,
		itemLabel: `Item ${key.toUpperCase()}`,
		itemIndex,
		itemCount,
		item: { id: key, name: key.toUpperCase() },
	};
}

describe("mapped LLM turns", () => {
	it("builds one LLM definition with item outcomes and a collection route", () => {
		const turn = mappedTurn();
		const definition = turn.definition;

		expect(turn.id).toBe("review_item");
		expect(definition.kind).toBe("llm");
		expect(Object.keys(definition.outcomes ?? {})).toEqual(["keep", "drop"]);
		expect(definition.outcomes?.keep).not.toHaveProperty("to");
		expect(definition.outcomes?.keep?.effect).toBeUndefined();
		expect(definition.turnResultMarkdown).toMatchObject({ mode: "outcome_tool_argument" });
		expect(definition.forEach?.routing).toMatchObject({
			kind: "branches",
			branches: { review: "review_kept", done: "deliver" },
		});
		expect(validateLlmTurnDefinition("review_item", definition)).toEqual([]);
	});

	it("gives prompts the active item from the worker context", async () => {
		const prompt = await mappedTurn().definition.prompt({
			...serverContext({ kept: [] }),
			iteration: iteration("b", 1, 3),
		});

		expect(prompt).toBe("Review B (2/3)");
	});

	it("applies shared settings independently to ordinary and mapped turns", () => {
		const builders = [flow.llm<Record<string, never>, State>("ordinary"), mappedBuilder()];
		for (const builder of builders) {
			builder
				.description("Assess")
				.askQuestions()
				.executionPurpose("assessment")
				.modelPurpose("process_title_generation")
				.tools("read", "bash")
				.integrationTools(" inspect ")
				.resolveIntegrationTools((_params, state) => (state.kept.length ? ["inspect"] : []))
				.consume("plan")
				.optionalConsume("review")
				.rootBranchReview()
				.continueFromProductBranch("plan")
				.buildPrompt(() => "Assess");

			if ("collect" in builder) {
				builder
					.outcomeTool("done", (outcome) =>
						outcome.description("Done").yield(({ ctx }) => ({ id: ctx.item.id, verdict: "keep" })),
					)
					.collect(({ state }) => state)
					.complete();
			} else {
				builder.end("done").complete();
			}
			const definition = builder.definition;
			expect(definition).toMatchObject({
				description: "Assess",
				askQuestions: true,
				executionPurpose: "assessment",
				modelPurpose: "process_title_generation",
				availableTools: ["read", "bash"],
				integrationTools: ["inspect"],
				consumedProducts: ["plan"],
				optionalConsumedProducts: ["review"],
				branchType: "root_branch",
				context: "full",
				restorePrimaryLeafAfterTurn: true,
				startFrom: { kind: "product_ref", productName: "plan", fallback: { kind: "current_leaf" } },
			});
			expect(definition.resolveIntegrationTools?.({}, { kept: ["a"] })).toEqual(["inspect"]);
			expect(definition.resolveIntegrationTools?.({}, { kept: [] })).toEqual([]);

			builder.freshPrimary();
			expect(builder.definition).toMatchObject({ branchType: "primary", context: "fresh" });
			expect(builder.definition.startFrom).toBeUndefined();
			expect(builder.definition.restorePrimaryLeafAfterTurn).toBeUndefined();
			builder.fullPrimary().continueFromPrimaryLeaf();
			expect(builder.definition).toMatchObject({
				context: "full",
				startFrom: { kind: "semantic_ref", ref: "currentPrimaryPathLeaf" },
			});
		}
		const ordinary = flow
			.llm("unconfigured")
			.description("Plain")
			.buildPrompt(() => "Plain");
		ordinary.end("done").complete();
		expect(ordinary.definition.askQuestions).toBeUndefined();
		expect(ordinary.definition.forEach).toBeUndefined();
	});

	it("prepares the decoded active item and combines prepared data with products in its prompt", async () => {
		const callIntegrationTool = vi.fn(async () => ({ evidence: "from inspection" }));
		const reportProgress = vi.fn();
		const definition = mappedBuilder()
			.integrationTools("inspect")
			.consume("plan")
			.prepare(async (ctx) => {
				ctx.reportProgress({ title: `Inspect ${ctx.itemLabel}`, steps: [] });
				const evidence = await ctx.callIntegrationTool("inspect", { id: ctx.item.id });
				return { evidence, name: ctx.item.name, position: ctx.itemIndex + 1 };
			})
			.optionalConsume("review")
			.buildPrompt(
				(ctx) =>
					`${ctx.prepared.name} ${ctx.prepared.position}/${ctx.itemCount}: ${ctx.input.plan}; ${ctx.input.review ?? "no review"}; ${JSON.stringify(ctx.prepared.evidence)}`,
			)
			.outcomeTool("keep", (outcome) =>
				outcome.description("Keep").yield(({ ctx }) => ({ id: ctx.item.id, verdict: "keep" })),
			)
			.collect(({ state }) => state)
			.complete().definition;
		const ctx: ProcessRuntimeTurnContext<Record<string, never>, State> = {
			...serverContext({ kept: [] }),
			callIntegrationTool,
			reportProgress,
			turnResultMarkdownByProduct: { plan: "the plan", review: "the review" },
			iteration: iteration("b", 1, 3),
		};
		const prepared = await definition.prepare?.(ctx);
		expect(callIntegrationTool).toHaveBeenCalledWith("inspect", { id: "b" });
		expect(reportProgress).toHaveBeenCalledWith({ title: "Inspect Item B", steps: [] });
		expect(await definition.prompt({ ...ctx, prepared })).toBe(
			'B 2/3: the plan; the review; {"evidence":"from inspection"}',
		);
		expect(
			await definition.prompt({
				...ctx,
				prepared,
				turnResultMarkdownByProduct: { plan: "the plan" },
			}),
		).toContain("no review");
		expect(() => definition.prompt({ ...ctx, prepared, turnResultMarkdownByProduct: {} })).toThrow(
			/requires product 'plan'/,
		);
		expect(() => definition.prompt({ ...ctx, prepared, iteration: undefined })).toThrow(
			/requires an active item/,
		);
		expect(() => definition.prepare?.({ ...ctx, iteration: undefined })).toThrow(
			/requires an active item/,
		);
		if (!ctx.iteration) throw new Error("missing iteration");
		expect(() =>
			definition.prompt({ ...ctx, prepared, iteration: { ...ctx.iteration, item: { id: "b" } } }),
		).toThrow(/Item needs id and name/);
	});

	it("builds item parameters without exposing routing or publication", () => {
		const definition = mappedBuilder()
			.buildPrompt(() => "Assess")
			.outcomeTool("assessed", (outcome) => {
				for (const method of ["to", "state", "effect", "complete", "routeByState", "markdown"]) {
					expect(outcome).not.toHaveProperty(method);
				}
				return outcome
					.description("Assessed")
					.resultSummary()
					.requiredString("reason")
					.requiredArray("findings", { items: { type: "object" } })
					.yield(({ ctx }) => ({ id: ctx.item.id, verdict: "keep" }));
			})
			.collect(({ state }) => state)
			.complete().definition;
		expect(definition.outcomes?.assessed).toMatchObject({
			description: "Assessed",
			resultSummaryParameter: "resultSummary",
			parameters: {
				reason: { type: "string", required: true, requiredErrorCode: "reason_required" },
				findings: { type: "array", required: true, items: { type: "object" } },
			},
		});
		expect(validateLlmTurnDefinition("review_item", definition)).toEqual([]);
	});

	it("compiles only collection routes into the business graph", () => {
		const process = flow
			.process<Record<string, never>, State>("mapped_process")
			.displayName("Mapped")
			.entry("review_item")
			.happyPath("review_item", "review_kept")
			.codecs({
				params: { parse: () => ({}), serialize: (value) => value },
				state: { parse: (value) => value as State, serialize: (value) => value },
			})
			.initialState(() => ({ kept: [] }))
			.turn(mappedTurn())
			.turn(
				flow
					.human<Record<string, never>, State>("review_kept")
					.description("Review kept items")
					.action("approve", (action) => action.label("Approve").complete()),
			)
			.turn(
				flow
					.human<Record<string, never>, State>("deliver")
					.description("Deliver")
					.action("finish", (action) => action.label("Finish").complete()),
			)
			.define();

		expect(getProcessTurnTransitions(process.turns.get("review_item"))).toEqual([
			{ nextTurnId: "review_kept", trigger: "collect:review" },
			{ nextTurnId: "deliver", trigger: "collect:done" },
		]);
	});

	it("requires a yielded result, collection, and collection route", () => {
		expect(() =>
			mappedBuilder().outcomeTool("keep", (outcome) => outcome.description("No yield")),
		).toThrow(/must declare \.yield/);
		expect(() => itemOutcomeBuilder().definition).toThrow(/must declare \.collect/);
		expect(() => itemOutcomeBuilder().collect(({ state }) => state).definition).toThrow(
			/must declare a collection route/,
		);
	});

	it("rejects ambiguous mapped completion and reserved item markdown", () => {
		const builder = itemOutcomeBuilder();
		expect(() => builder.outcomeTool("keep", (outcome) => outcome)).toThrow(/duplicate outcome/);
		expect(() => builder.outcomeTool(" ", (outcome) => outcome)).toThrow(/empty outcome/);
		const collect = builder.collect(({ state }) => state);
		expect(() => builder.collect(({ state }) => state)).toThrow(/more than once/);
		collect.to("next");
		expect(() => collect.complete()).toThrow(/already declares a route/);
		expect(
			() =>
				mappedBuilder()
					.buildPrompt(() => "Assess")
					.outcomeTool("keep", (outcome) =>
						outcome
							.description("Keep")
							.requiredString("markdown")
							.yield(({ ctx }) => ({ id: ctx.item.id, verdict: "keep" })),
					)
					.collect(({ state }) => state)
					.complete().definition,
		).toThrow(/reserved markdown parameter/);
	});

	it("rejects hand-authored mapped outcomes that route", () => {
		const definition = {
			...mappedTurn().definition,
			outcomes: {
				keep: { description: "Keep", parameters: {}, to: "deliver" },
				drop: { description: "Drop", parameters: {} },
			},
		};
		expect(validateLlmTurnDefinition("review_item", definition)).toContain(
			"Mapped turn 'review_item' outcome 'keep' cannot route, change state, or publish",
		);
	});

	it("freezes validated items in order and applies the snapshot reducer", () => {
		const spec = mappedTurn().definition.forEach;
		if (!spec) throw new Error("missing mapped spec");
		const frozen = freezeMappedItems(
			"review_item",
			spec,
			serverContext({
				pending: [
					{ id: "a", name: "A" },
					{ id: "b", name: "B" },
				],
				kept: [],
			}),
		);

		expect(frozen.items).toEqual([
			{ itemIndex: 0, itemKey: "a", label: "Item A", itemJson: '{"id":"a","name":"A"}' },
			{ itemIndex: 1, itemKey: "b", label: "Item B", itemJson: '{"id":"b","name":"B"}' },
		]);
		expect(frozen.state).toEqual({ pending: undefined, kept: [] });
		expect(freezeMappedItems("review_item", spec, serverContext({ kept: [] })).items).toEqual([]);
	});

	it.each([
		[
			"duplicate keys",
			[
				{ id: "a", name: "A" },
				{ id: "a", name: "B" },
			],
			"duplicate_mapped_item_key",
		],
		["invalid items", [{ id: "a" }], "invalid_mapped_item"],
		["empty keys", [{ id: " ", name: "A" }], "invalid_mapped_item_key"],
	])("rejects %s when freezing", (_name, pending, code) => {
		const spec = mappedTurn().definition.forEach;
		if (!spec) throw new Error("missing mapped spec");
		expect(() =>
			freezeMappedItems(
				"review_item",
				spec,
				serverContext({ pending: pending as Item[], kept: [] }),
			),
		).toThrow(expect.objectContaining({ code }));
	});

	it("yields codec-validated results and collects them once in order", async () => {
		const spec = mappedTurn().definition.forEach;
		if (!spec) throw new Error("missing mapped spec");
		const ctx = serverContext({ kept: [] });
		const keep = await yieldMappedItemResult({
			turnId: "review_item",
			spec,
			ctx,
			iteration: iteration("a", 0, 2),
			event: { turnRecordId: "trn_1", turnId: "review_item", outcome: "keep", params: {} },
		});
		const drop = await yieldMappedItemResult({
			turnId: "review_item",
			spec,
			ctx,
			iteration: iteration("b", 1, 2),
			event: { turnRecordId: "trn_2", turnId: "review_item", outcome: "drop", params: {} },
		});

		expect([keep, drop]).toEqual(['{"id":"a","verdict":"keep"}', '{"id":"b","verdict":"drop"}']);
		await expect(
			collectMappedResults({ turnId: "review_item", spec, ctx, resultJsons: [keep, drop] }),
		).resolves.toEqual({
			state: { kept: ["a"] },
			route: { trigger: "collect:review", nextTurnId: "review_kept" },
		});
		await expect(
			collectMappedResults({ turnId: "review_item", spec, ctx, resultJsons: [] }),
		).resolves.toEqual({
			state: { kept: [] },
			route: { trigger: "collect:done", nextTurnId: "deliver" },
		});
	});

	it("rejects results that fail the result codec as safe planning errors", async () => {
		const spec = mappedTurn().definition.forEach;
		if (!spec) throw new Error("missing mapped spec");
		const invalid = {
			...spec,
			yields: { keep: () => ({ id: 1 }) },
		};
		await expect(
			yieldMappedItemResult({
				turnId: "review_item",
				spec: invalid,
				ctx: serverContext({ kept: [] }),
				iteration: iteration("a"),
				event: { turnRecordId: "trn_1", turnId: "review_item", outcome: "keep", params: {} },
			}),
		).rejects.toBeInstanceOf(SafeOutcomePlanningError);
	});
});
