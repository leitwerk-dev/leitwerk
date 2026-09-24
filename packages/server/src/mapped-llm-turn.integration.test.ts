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
	.llm<Params, State>("review_item")
	.description("Review one item")
	.freshPrimary()
	.forEach<Item, Result>({
		items: ({ state }) => state.pending,
		itemCodec,
		resultCodec,
		key: ({ item }) => item.id,
		label: ({ item }) => `Item ${item.name}`,
		stateAfterSnapshot: ({ state }) => ({ kept: state.kept }),
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
	.define();

async function fixture(items: Item[], resolver: StubToolCallScriptResolver) {
	const persistent = createPersistentIntegrationFixture("leitwerk-mapped-turn-");
	onTestFinished(persistent.dispose);
	const config = persistent.createConfig();
	config.workers.shutdown_grace_period = "100ms";
	config.extension_loading.sources = [];
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
				api.registerProcess(processDefinition);
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
		processId: processDefinition.id,
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
