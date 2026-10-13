import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { type Codec, flow } from "@leitwerk-dev/process-sdk";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import {
	createPersistentIntegrationFixture,
	waitForValue,
} from "@leitwerk-dev/test-support/integration";
import {
	StubPiTreeHandleFactory,
	type StubToolCallScriptResolver,
} from "@leitwerk-dev/test-support/worker-testing";
import { expect, it, onTestFinished } from "vitest";

interface Item {
	id: string;
	name: string;
}
interface Result {
	id: string;
	keep: boolean;
}
interface Params {
	items: Item[];
}
interface State {
	pending?: Item[];
	kept: string[];
}

const itemCodec: Codec<Item> = {
	parse(value) {
		const input = value as Partial<Item>;
		if (typeof input?.id !== "string" || typeof input.name !== "string") throw new Error("item");
		return { id: input.id, name: input.name };
	},
	serialize: (value) => value,
};
const resultCodec: Codec<Result> = {
	parse(value) {
		const input = value as Partial<Result>;
		if (typeof input?.id !== "string" || typeof input.keep !== "boolean") throw new Error("result");
		return { id: input.id, keep: input.keep };
	},
	serialize: (value) => value,
};

const review = flow
	.mappedLlm<Params, State, Item, Result>("review_item", {
		items: ({ state }) => state.pending,
		itemCodec,
		resultCodec,
		key: ({ item }) => item.id,
		label: ({ item }) => `Item ${item.name}`,
		stateAfterSnapshot: ({ state }) => ({ kept: state.kept }),
	})
	.description("Review one item")
	.freshPrimary()
	.prepare(({ item }) => ({ itemId: item.id }))
	.validateOutcome(({ item, prepared }, outcome) => {
		if ((prepared as { itemId: string }).itemId !== item.id)
			return ["Preparation belongs to another item"];
		return outcome.outcome === "keep" && outcome.params.reason !== "relevant"
			? [`Explain why ${item.name} is relevant before keeping it`]
			: [];
	})
	.buildPrompt(
		(ctx) =>
			`Review ${ctx.item.name} (${ctx.itemIndex + 1} of ${ctx.itemCount}); state ${JSON.stringify(ctx.state)}`,
	)
	.outcomeTool("keep", (outcome) =>
		outcome
			.description("Keep this item")
			.requiredString("reason", "Why the item stays")
			.yield(({ ctx }) => ({ id: ctx.item.id, keep: true })),
	)
	.outcomeTool("drop", (outcome) =>
		outcome.description("Drop this item").yield(({ ctx }) => ({ id: ctx.item.id, keep: false })),
	)
	.collect(({ state }, results) => ({
		...state,
		kept: results.filter((result) => result.keep).map((result) => result.id),
	}))
	.to("summarize");

const summarize = flow
	.llm<Params, State>("summarize")
	.description("Summarize kept items")
	.freshPrimary()
	.prompt((ctx) => `Summarize ${ctx.state.kept.join(", ") || "nothing"}`);
summarize.end("summarized").complete();

const processDefinition = flow
	.process<Params, State>("mapped_test")
	.displayName("Mapped test")
	.entry("review_item")
	.happyPath("review_item", "summarize")
	.codecs({
		params: { parse: (value) => value as Params, serialize: (value) => value },
		state: { parse: (value) => value as State, serialize: (value) => value },
	})
	.initialState((params) => ({ pending: params.items, kept: [] }))
	.turn(review)
	.turn(summarize)
	.ui((api) =>
		api.leafOutcome({
			rendererId: "mapped-test:item",
			capture({ mappedResult }) {
				return mappedResult
					? {
							rendererId: "mapped-test:item",
							schemaVersion: 1,
							props: mappedResult as unknown as Record<string, unknown>,
							fallbackMarkdown: JSON.stringify(mappedResult),
						}
					: null;
			},
		}),
	)
	.define();

async function fixture(
	items: Item[],
	resolver: StubToolCallScriptResolver,
	definition = processDefinition,
) {
	const persistent = createPersistentIntegrationFixture("leitwerk-mapped-turn-");
	onTestFinished(persistent.dispose);
	const config = persistent.createConfig();
	config.workers.shutdown_grace_period = "100ms";
	config.extension_loading.sources = [];
	config.pi.default_model_profile = "mapped-model";
	config.pi.model_profiles = [
		{
			id: "mapped-model",
			provider: "mapped-provider",
			model_id: "fixture-model",
			thinking_level: "off",
		},
	];
	const catalog = await buildExtensionCatalogFromModules([
		{
			manifest: { id: "mapped-test", version: "0.1.0" },
			modelProviders: fixtureModelProviders({
				id: "mapped-provider",
				modelId: "fixture-model",
				piProvider: "ollama",
			}),
			setupCatalog(api) {
				api.registerProcess(definition);
			},
		},
	]);
	const open = () =>
		persistent.open({
			config,
			extensionCatalog: catalog,
			inProcessWorkers: {
				piFactory: new StubPiTreeHandleFactory({
					recordSessionTrace: true,
					toolCallScriptResolver: resolver,
				}),
			},
		});
	const h = await open();
	const process = h.ctx.deps.processes.create({
		processId: definition.id,
		lifecycleStatus: "discovered",
		selectedTurnId: null,
		defaultModelProfileId: "mapped-model",
		paramsJson: JSON.stringify({ items }),
	});
	expect((await h.ctx.deps.processEngine.startProcess(process.id, "review_item")).ok).toBe(true);
	return {
		get ctx() {
			return persistent.context();
		},
		id: process.id,
		async restart() {
			await persistent.close();
			await open();
		},
		async wait(status: string) {
			await waitForValue(
				() => persistent.context().deps.processes.getById(process.id),
				(value) => value?.lifecycleStatus === status,
			);
		},
	};
}

const items: Item[] = [
	{ id: "a", name: "Alpha" },
	{ id: "b", name: "Bravo" },
	{ id: "c", name: "Charlie" },
];

it("returns correction feedback and accepts only the corrected assessment within one mapped turn", async () => {
	const responses: unknown[] = [];
	const f = await fixture([items[0]], (context) => {
		if (!context.iteration)
			return { calls: [{ toolName: "summarized", args: {} }], textChunks: ["Summary"] };
		return {
			calls: [{ toolName: "keep", args: { reason: "guess", markdown: "Invalid draft" } }],
			afterToolResult(call, result) {
				responses.push(result);
				return call.args.reason === "guess"
					? { toolName: "keep", args: { reason: "relevant", markdown: "Verified draft" } }
					: undefined;
			},
		};
	});
	await f.wait("completed");
	expect(responses[0]).toMatchObject({
		ok: false,
		status: "invalid",
		errors: ["Explain why Alpha is relevant before keeping it"],
	});
	expect(responses[1]).toMatchObject({ status: "ok", outcome: "keep" });
	const records = f.ctx.deps.turnRecords
		.listByInstance(f.id)
		.filter((record) => record.turnId === "review_item");
	expect(records).toHaveLength(1);
	expect(records[0].status).toBe("succeeded");
	const [run] = f.ctx.deps.mappedRuns.listByInstance(f.id);
	expect(f.ctx.deps.mappedRuns.listItems(run.id)[0].resultJson).toBe('{"id":"a","keep":true}');
	expect(f.ctx.deps.leafOutcomeSnapshots.listByInstance(f.id)).toContainEqual(
		expect.objectContaining({ turnRecordId: records[0].id, props: { id: "a", keep: true } }),
	);
});

it("runs one durable LLM turn per frozen item, retries the failed item, and collects once", async () => {
	const prompts: string[] = [];
	let failBravo = true;
	const f = await fixture(items, (context) => {
		if (!context.iteration) {
			return { calls: [{ toolName: "summarized", args: {} }], textChunks: ["Summary"] };
		}
		prompts.push(context.identifiedPromptText ?? context.promptText);
		const item = context.iteration.item as Item;
		if (item.id === "b" && failBravo) {
			failBravo = false;
			throw new Error("Scripted item failure");
		}
		return item.id === "c"
			? { calls: [{ toolName: "drop", args: { markdown: `Dropped ${item.name}` } }] }
			: {
					calls: [
						{
							toolName: "keep",
							args: { reason: "relevant", markdown: `Kept ${item.name}` },
						},
					],
				};
	});

	await f.wait("error");
	const failed = f.ctx.deps.turnRecords
		.listByInstance(f.id)
		.find((record) => record.status === "failed");
	expect(failed?.iteration).toMatchObject({ itemKey: "b", itemIndex: 1 });
	const [run] = f.ctx.deps.mappedRuns.listByInstance(f.id);
	expect(run).toMatchObject({ status: "active", itemCount: 3, nextIndex: 1 });
	expect(JSON.parse(f.ctx.deps.processes.getById(f.id)?.stateJson ?? "{}")).not.toHaveProperty(
		"pending",
	);

	await f.restart();
	const retried = await f.ctx.app.inject({ method: "POST", url: `/api/processes/${f.id}/retry` });
	expect(retried.statusCode, retried.body).toBe(200);
	await f.wait("completed");

	const records = f.ctx.deps.turnRecords.listByInstance(f.id);
	const reviewRecords = records.filter((record) => record.turnId === "review_item");
	expect(reviewRecords.map((record) => [record.iteration?.itemKey, record.status])).toEqual([
		["a", "succeeded"],
		["b", "failed"],
		["b", "succeeded"],
		["c", "succeeded"],
	]);
	expect(reviewRecords[2]?.parentTurnRecordId).toBe(reviewRecords[1]?.id);
	expect(records.filter((record) => record.turnId === "summarize")).toHaveLength(1);
	expect(JSON.parse(f.ctx.deps.processes.getById(f.id)?.stateJson ?? "{}")).toMatchObject({
		kept: ["a", "b"],
	});
	expect(f.ctx.deps.mappedRuns.listByInstance(f.id)).toEqual([
		expect.objectContaining({ status: "completed", nextIndex: 3 }),
	]);
	expect(
		f.ctx.deps.mappedRuns.listItems(run?.id ?? "").map((item) => [item.itemKey, item.resultJson]),
	).toEqual([
		["a", '{"id":"a","keep":true}'],
		["b", '{"id":"b","keep":true}'],
		["c", '{"id":"c","keep":false}'],
	]);
	expect(prompts.some((prompt) => prompt.includes("Review Alpha (1 of 3)"))).toBe(true);
	expect(prompts.some((prompt) => prompt.includes("Review Charlie (3 of 3)"))).toBe(true);
	for (const prompt of prompts) {
		const others = items.filter((item) => !prompt.includes(`Review ${item.name}`));
		for (const other of others) expect(prompt).not.toContain(other.name);
	}
	expect(
		f.ctx.deps.events
			.listByInstance(f.id)
			.filter((event) => event.eventType === "mapped_run_collected"),
	).toHaveLength(1);
});

it("rejects replayed item outcomes, aborts the active run, and deletes it with the process", async () => {
	const f = await fixture(items, (context) => {
		const item = context.iteration?.item as Item | undefined;
		if (item?.id === "b") throw new Error("Scripted item failure");
		return { calls: [{ toolName: "drop", args: { markdown: `Dropped ${item?.name}` } }] };
	});
	await f.wait("error");
	const [first] = f.ctx.deps.turnRecords.listByInstance(f.id);
	const replay = await f.ctx.deps.processEngine.recordTurnOutcome(f.id, {
		turnRecordId: first?.id ?? "",
		turnId: "review_item",
		turnType: "llm",
		outcome: "drop",
		params: { markdown: "Replayed" },
	});
	expect(replay.ok).toBe(false);
	const [run] = f.ctx.deps.mappedRuns.listByInstance(f.id);
	expect(f.ctx.deps.mappedRuns.getItem(run?.id ?? "", 0)?.turnRecordId).toBe(first?.id);
	expect(run).toMatchObject({ status: "active", nextIndex: 1 });

	const aborted = await f.ctx.app.inject({ method: "POST", url: `/api/processes/${f.id}/abort` });
	expect(aborted.statusCode, aborted.body).toBe(200);
	await f.wait("aborted");
	expect(f.ctx.deps.mappedRuns.getById(run?.id ?? "")?.status).toBe("aborted");

	const deleted = await f.ctx.app.inject({ method: "DELETE", url: `/api/processes/${f.id}` });
	expect(deleted.statusCode, deleted.body).toBeLessThan(300);
	await waitForValue(
		() => f.ctx.deps.processes.getById(f.id),
		(value) => value === null,
	);
	expect(f.ctx.deps.mappedRuns.listByInstance(f.id)).toEqual([]);
	expect(f.ctx.deps.mappedRuns.listItemsByInstance(f.id)).toEqual([]);
});

it("collects an empty item list without starting an item turn", async () => {
	const f = await fixture([], (context) => {
		expect(context.iteration).toBeUndefined();
		return { calls: [{ toolName: "summarized", args: {} }], textChunks: ["Summary"] };
	});
	await f.wait("completed");
	expect(f.ctx.deps.turnRecords.listByInstance(f.id).map((record) => record.turnId)).toEqual([
		"summarize",
	]);
	expect(f.ctx.deps.mappedRuns.listByInstance(f.id)).toEqual([
		expect.objectContaining({ status: "completed", itemCount: 0 }),
	]);
});

it("freezes each item's resolved union on the server and retains it through restart", async () => {
	let prefix = "initial";
	const resolvedItems: string[] = [];
	const choice = (tag: string) => ({
		type: "object" as const,
		properties: { kind: { type: "string" as const, enum: [tag] } },
		required: ["kind"],
		additionalProperties: false,
	});
	const mapped = flow
		.mappedLlm<Params, State, Item, Result>("review_item", {
			items: ({ state }) => state.pending,
			itemCodec,
			resultCodec,
			key: ({ item }) => item.id,
		})
		.description("Resolve item action")
		.freshPrimary()
		.buildPrompt(({ item }) => `Review ${item.name}`)
		.outcomeTool("decide", (outcome) =>
			outcome
				.description("Decide")
				.union("action", [choice("placeholder")], { required: true })
				.resolveParameters(({ item }) => {
					resolvedItems.push(item.id);
					return {
						action: {
							description: "Action",
							required: true,
							anyOf: [choice(`${prefix}:${item.id}`)],
						},
					};
				})
				.strictSchema()
				.yield(({ ctx }) => ({ id: ctx.item.id, keep: true })),
		)
		.collect(({ state }, results) => ({ ...state, kept: results.map((result) => result.id) }))
		.complete();
	const definition = flow
		.process<Params, State>("frozen_contract_test")
		.displayName("Frozen contract")
		.entry("review_item")
		.codecs({
			params: { parse: (value) => value as Params, serialize: (value) => value },
			state: { parse: (value) => value as State, serialize: (value) => value },
		})
		.initialState((params) => ({ pending: params.items, kept: [] }))
		.turn(mapped)
		.define();
	const f = await fixture(
		items.slice(0, 2),
		(context) => {
			const item = context.iteration!.item as Item;
			const tag = `${prefix}:${item.id}`;
			// Change the live definition after the prepared start, before acceptance.
			prefix = "changed";
			return {
				calls: [
					{
						toolName: "decide",
						args: { action: { kind: tag }, markdown: `Reviewed ${item.name}` },
					},
				],
			};
		},
		definition,
	);
	await f.wait("completed");
	expect(resolvedItems).toEqual(["a", "b"]);
	const starts = f.ctx.deps.turnStarts.listByInstance(f.id);
	const contracts = starts.map((start) =>
		start.state.kind === "accepted" && start.state.start?.kind === "llm"
			? start.state.start.outcomeContract
			: null,
	);
	expect(contracts).toMatchObject([
		{
			outcomes: {
				decide: { strictSchema: true, parameters: { action: { anyOf: [choice("initial:a")] } } },
			},
		},
		{ outcomes: { decide: { parameters: { action: { anyOf: [choice("changed:b")] } } } } },
	]);
	await f.restart();
	expect(f.ctx.deps.turnStarts.listByInstance(f.id)).toEqual(starts);
});
