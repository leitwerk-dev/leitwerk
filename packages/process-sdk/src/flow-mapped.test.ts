import { describe, expect, it } from "vitest";
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

function mappedTurn() {
	return flow
		.llm<Record<string, never>, State>("review_item")
		.description("Review one item")
		.freshPrimary()
		.forEach<Item, Result>({
			items: ({ state }) => state.pending,
			itemCodec,
			resultCodec,
			key: ({ item }) => item.id,
			label: ({ item }) => `Item  ${item.name}\n`,
			stateAfterSnapshot: ({ state }) => ({ ...state, pending: undefined }),
		})
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
			params: {},
			state: { kept: [] },
			process: {},
			projects: [],
			iteration: {
				runId: "run_1",
				itemKey: "b",
				itemLabel: "Item B",
				itemIndex: 1,
				itemCount: 3,
				item: { id: "b", name: "B" },
			},
		} as never);

		expect(prompt).toBe("Review B (2/3)");
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

	it("rejects item-level routing, state, and publication", () => {
		const base = () =>
			flow
				.llm<Record<string, never>, State>("review_item")
				.description("Review one item")
				.forEach<Item, Result>({
					items: () => [],
					itemCodec,
					resultCodec,
					key: ({ item }) => item.id,
				});
		const builder = flow.llm("plain").description("Plain");
		builder.forEach({ items: () => [], itemCodec, resultCodec, key: () => "k" });
		expect(() => builder.publish("summary")).toThrow(/cannot declare \.publish/);
		expect(() => builder.end("done")).toThrow(/cannot declare \.end/);
		expect(() => builder.outcomeTool("done", (outcome) => outcome.to("next"))).toThrow(
			/cannot declare routed outcome tools/,
		);
		expect(() => base().outcomeTool("keep", (outcome) => outcome.description("No yield"))).toThrow(
			/must declare \.yield/,
		);
		expect(
			() =>
				base()
					.buildPrompt(() => "Review")
					.outcomeTool("keep", (outcome) =>
						outcome.description("Keep").yield(({ ctx }) => ({ id: ctx.item.id, verdict: "keep" })),
					).definition,
		).toThrow(/must declare \.collect/);
		expect(
			() =>
				base()
					.buildPrompt(() => "Review")
					.outcomeTool("keep", (outcome) =>
						outcome.description("Keep").yield(({ ctx }) => ({ id: ctx.item.id, verdict: "keep" })),
					)
					.collect(({ state }) => state).definition,
		).toThrow(/must declare a collection route/);
		const late = flow.llm("late").description("Late");
		late.end("done");
		expect(() => late.forEach({} as never)).toThrow(/before its completion path/);
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
			{ index: 0, key: "a", label: "Item A", itemJson: '{"id":"a","name":"A"}' },
			{ index: 1, key: "b", label: "Item B", itemJson: '{"id":"b","name":"B"}' },
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
		const iteration = (key: string, itemIndex: number) => ({
			runId: "run_1",
			itemKey: key,
			itemLabel: key,
			itemIndex,
			itemCount: 2,
			item: { id: key, name: key },
		});
		const keep = await yieldMappedItemResult({
			turnId: "review_item",
			spec,
			ctx,
			iteration: iteration("a", 0),
			event: { turnRecordId: "trn_1", turnId: "review_item", outcome: "keep", params: {} },
		});
		const drop = await yieldMappedItemResult({
			turnId: "review_item",
			spec,
			ctx,
			iteration: iteration("b", 1),
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
				iteration: {
					runId: "run_1",
					itemKey: "a",
					itemLabel: "a",
					itemIndex: 0,
					itemCount: 1,
					item: { id: "a", name: "A" },
				},
				event: { turnRecordId: "trn_1", turnId: "review_item", outcome: "keep", params: {} },
			}),
		).rejects.toBeInstanceOf(SafeOutcomePlanningError);
	});
});
