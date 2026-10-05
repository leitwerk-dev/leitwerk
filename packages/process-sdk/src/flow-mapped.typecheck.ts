import { type Codec, type FlowForEachOptions, flow } from "./index.js";

interface Params {
	prefix: string;
}
interface State {
	kept: string[];
}
interface Item {
	id: string;
}
interface Result {
	id: string;
	keep: boolean;
}

// Compiled but never called: check the supported authoring API and its forbidden capabilities.
function checkMappedAuthoring(itemCodec: Codec<Item>, resultCodec: Codec<Result>) {
	const items: FlowForEachOptions<Params, State, Item, Result> = {
		items: ({ state }) => state.kept.map((id) => ({ id })),
		itemCodec,
		resultCodec,
		key: ({ item }) => item.id,
	};
	// Infer all four types from a typed item source.
	const mapped = flow
		.mappedLlm("assess", items)
		.description("Assess one item")
		.consume("plan")
		.prepare(async (ctx) => {
			const item: Item = ctx.item;
			const state: State = ctx.state;
			const params: Params = ctx.params;
			// @ts-expect-error Preparation cannot route the item.
			ctx.to("next");
			return { label: `${params.prefix}${item.id}`, count: state.kept.length };
		})
		.optionalConsume("review")
		.waitFor(({ params, state }) => {
			const prefix: string = params.prefix;
			const kept: string[] = state.kept;
			return prefix.length > 0 && kept.length > 0;
		})
		.askQuestions()
		.executionPurpose("assessment")
		.resolveIntegrationTools((params, state) => [params.prefix, ...state.kept])
		.fullPrimary()
		.continueFromPrimaryLeaf()
		.buildPrompt((ctx) => {
			const label: string = ctx.prepared.label;
			const count: number = ctx.prepared.count;
			const item: Item = ctx.item;
			const plan: string | undefined = ctx.input.plan;
			const review: string | undefined = ctx.input.review;
			// @ts-expect-error Prepared data preserves its inferred property types.
			const invalid: string = ctx.prepared.count;
			void invalid;
			// @ts-expect-error Only declared products are available.
			ctx.input.undeclared;
			// @ts-expect-error Items retain the codec's type.
			ctx.item.missing;
			return `${label} ${count} ${item.id} ${plan} ${review}`;
		})
		.outcomeTool("assessed", (outcome) => {
			// @ts-expect-error Item outcomes cannot route.
			outcome.to("next");
			// @ts-expect-error Item outcomes cannot change business state.
			outcome.state(() => ({ kept: [] }));
			// @ts-expect-error Item outcomes cannot publish products.
			outcome.markdown("review", { publish: true });
			// @ts-expect-error Item yields must match the result codec.
			outcome.yield(() => ({ id: "a", keep: "yes" }));
			return outcome
				.description("Assessed")
				.requiredBoolean("keep")
				.yield(({ ctx, event }) => ({ id: ctx.item.id, keep: event.params.keep === true }));
		});
	// @ts-expect-error Mapped turns have no ordinary completion path after context refinement.
	mapped.end("done");
	// @ts-expect-error Mapped turns cannot publish products.
	mapped.publish("review");
	// @ts-expect-error Collection must return the process state.
	mapped.collect(() => ({ wrong: true }));
	const collected = mapped.collect(({ params, state }, results) => {
		const typed: readonly Result[] = results;
		// @ts-expect-error Collection receives ordered, read-only results.
		results.push({ id: "a", keep: true });
		// @ts-expect-error Result fields remain typed after all common configuration.
		const invalid: string = results[0].keep;
		void invalid;
		return { ...state, kept: typed.filter((r) => r.keep).map((r) => `${params.prefix}${r.id}`) };
	});
	collected.routeByState({ again: "assess", done: "review" }, ({ state }) =>
		state.kept.length ? "again" : "done",
	);
	// @ts-expect-error Item authoring ends at collection.
	collected.outcomeTool("late", () => undefined);

	// Explicit generic arguments remain available for inline sources.
	flow.mappedLlm<Params, State, Item, Result>("explicit", {
		...items,
		key: ({ item }) => item.id,
	});
	// Codecs infer item/result types when process types are unnecessary.
	flow
		.mappedLlm("inferred", { items: () => [], itemCodec, resultCodec, key: ({ item }) => item.id })
		.prepare(({ item }) => ({ name: item.id }))
		.consume("plan")
		.buildPrompt(({ item, prepared, input }) => `${item.id}${prepared.name}${input.plan}`)
		.outcomeTool("done", (outcome) =>
			outcome.description("Done").yield(({ ctx }) => ({ id: ctx.item.id, keep: true })),
		)
		.collect((_ctx, results) => results.map((result) => result.keep));

	const ordinary = flow
		.llm<Params, State>("ordinary")
		.optionalConsume("review")
		.prepare(({ params }) => ({ label: params.prefix }))
		.consume("plan")
		.buildPrompt((ctx) => {
			// @ts-expect-error Ordinary prompts do not receive mapped items.
			ctx.item;
			return `${ctx.prepared.label}${ctx.input.plan}${ctx.input.review}`;
		});
	ordinary.outcomeTool("done", (outcome) =>
		outcome
			.description("Done")
			.state(({ ctx }) => ctx.state)
			.complete(),
	);
	// @ts-expect-error Ordinary turns cannot be converted into mapped turns.
	ordinary.forEach(items);
	// @ts-expect-error Ordinary builders retain ordinary completion after context refinement.
	ordinary.collect(() => ({ kept: [] }));
}
void checkMappedAuthoring;
