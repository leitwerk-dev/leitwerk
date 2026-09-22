import {
	coreHostCapabilities,
	emptyParamsCodec,
	flow,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { expect, it } from "vitest";
import { createExtensionIntegrationHarness } from "./extension-integration-harness.js";
import { fixtureModelProviders } from "./model-provider-fixtures.js";

const stateCodec = { parse: () => ({}), serialize: (value: Record<string, never>) => value };
const definition = flow
	.process("integration_fixture")
	.displayName("Integration fixture")
	.entry("first")
	.codecs({ params: emptyParamsCodec, state: stateCodec })
	.initialState(() => ({}))
	.turn(
		flow
			.automatic("first")
			.description("First")
			.run(() => ({ outcome: "done", markdown: "First result" }))
			.outcome("done", (outcome) => outcome.description("Next").to("second")),
	)
	.turn(
		flow
			.automatic("second")
			.description("Second")
			.run(() => ({ outcome: "done", markdown: "Second result" }))
			.outcome("done", (outcome) => outcome.description("Finish").complete()),
	)
	.define();
const extension: LeitwerkExtensionModule = {
	manifest: { id: "integration-fixture", version: "1.0.0" },
	setupCatalog(api) {
		api.registerProcess(definition);
	},
};

it("manual execution accepts exactly one automatic turn and survives reopening", async () => {
	const test = await createExtensionIntegrationHarness({
		extensions: [extension],
		execution: "manual",
	});
	try {
		const process = await test.createProcess(definition);
		expect(process.snapshot().turns).toHaveLength(0);
		const first = await process.runTurn();
		expect(first.turn).toMatchObject({
			turnId: "first",
			status: "succeeded",
			turnResultMarkdown: "First result",
		});
		expect(process.snapshot().process.selectedTurnId).toBe("second");
		expect(process.snapshot().turns).toHaveLength(1);
		await test.restart();
		expect(process.snapshot().turns).toHaveLength(1);
		const second = await process.runTurn();
		expect(second.turn).toMatchObject({ turnId: "second", status: "succeeded" });
		expect(process.snapshot().process.lifecycleStatus).toBe("completed");
		expect(Object.isFrozen(process.snapshot().turns)).toBe(true);
	} finally {
		await test.close();
	}
	await test.close();
}, 30000);

it("automatic execution is the default and HTTP errors remain observable", async () => {
	const test = await createExtensionIntegrationHarness({ extensions: [extension] });
	try {
		const process = await test.createProcess(definition);
		const snapshot = await process.waitFor(
			(snapshot) => snapshot.process.lifecycleStatus === "completed",
		);
		expect(snapshot.turns).toHaveLength(2);
		await expect(process.runTurn()).rejects.toThrow("manual execution");
		expect((await test.request({ url: "/not-a-route" })).statusCode).toBe(404);
	} finally {
		await test.close();
	}
}, 30000);

it("seeds historical accepted results without changing position or partially writing conflicts", async () => {
	const test = await createExtensionIntegrationHarness({
		extensions: [extension],
		execution: "manual",
	});
	try {
		const process = await test.createProcess(definition, {
			position: { selectedTurnId: "second", lifecycleStatus: "waiting" },
		});
		const before = process.snapshot();
		const retained = await process.seedAcceptedTurn({
			turnId: "first",
			execution: { status: "succeeded", outcome: "done", markdown: "Retained result" },
		});
		expect(retained.artifact).toEqual({ kind: "turn_result", turnRecordId: retained.id });
		expect(process.snapshot().process).toEqual(before.process);
		await test.restart();
		expect(process.snapshot().turns[0]).toMatchObject({
			id: retained.id,
			turnResultMarkdown: "Retained result",
			status: "succeeded",
		});
		await expect(
			process.seedAcceptedTurn({ turnId: "missing", execution: { status: "running" } }),
		).rejects.toThrow("Undeclared");
		expect(process.snapshot().turns).toHaveLength(1);
		await process.seedAcceptedTurn({ turnId: "second", execution: { status: "running" } });
		await expect(
			process.seedAcceptedTurn({
				turnId: "first",
				execution: { status: "succeeded", outcome: "done", markdown: "Another" },
			}),
		).rejects.toThrow("live execution");
		expect(process.snapshot().turns).toHaveLength(2);
	} finally {
		await test.close();
	}
}, 30000);

it("records accepted automatic failure without moving position and retries with a new attempt", async () => {
	let attempts = 0;
	const failing = flow
		.process("retry_fixture")
		.displayName("Retry fixture")
		.entry("work")
		.codecs({ params: emptyParamsCodec, state: stateCodec })
		.initialState(() => ({}))
		.turn(
			flow
				.automatic("work")
				.description("Work")
				.run(() => {
					if (++attempts === 1) throw new Error("Temporary boundary failure");
					return { outcome: "done", markdown: "Recovered" };
				})
				.outcome("done", (outcome) => outcome.description("Finish").complete()),
		)
		.define();
	const test = await createExtensionIntegrationHarness({
		execution: "manual",
		extensions: [
			{
				manifest: { id: "retry-fixture", version: "1" },
				setupCatalog(api) {
					api.registerProcess(failing);
				},
			},
		],
	});
	try {
		const process = await test.createProcess(failing);
		const failed = await process.runTurn();
		expect(failed.failure).toContain("Temporary boundary failure");
		expect(failed.turn).toMatchObject({ status: "failed", attemptNumber: 1 });
		expect(process.snapshot().process).toMatchObject({
			selectedTurnId: "work",
			lifecycleStatus: "error",
		});
		await process.retry();
		const recovered = await process.runTurn();
		expect(recovered.turn).toMatchObject({ status: "succeeded", attemptNumber: 2 });
		expect(recovered.failure).toBeNull();
		expect(process.snapshot().process.lifecycleStatus).toBe("completed");
	} finally {
		await test.close();
	}
}, 30000);

it("executes scripted LLM outcomes and reports script exhaustion as a durable failure", async () => {
	const llm = flow
		.process("llm_fixture")
		.displayName("LLM fixture")
		.entry("work")
		.codecs({ params: emptyParamsCodec, state: stateCodec })
		.initialState(() => ({}))
		.turn(
			flow
				.llm("work")
				.description("Work")
				.prompt(() => "Produce a test result")
				.outcomeTool("done", (outcome) => outcome.description("Finish").complete()),
		)
		.define();
	const test = await createExtensionIntegrationHarness({
		execution: "manual",
		extensions: [
			{
				manifest: { id: "llm-fixture", version: "1" },
				setupCatalog(api) {
					api.registerProcess(llm);
				},
				modelProviders: fixtureModelProviders({
					id: "fixture",
					modelId: "fixture-model",
					server: true,
				}),
			},
		],
		models: [{ id: "test", provider: "fixture", modelId: "fixture-model" }],
		defaultModel: "test",
	});
	try {
		const process = await test.createProcess(llm);
		const failed = await process.runTurn({ tools: [] });
		expect(failed.failure).toContain("Script exhausted");
		expect(process.snapshot().process).toMatchObject({
			selectedTurnId: "work",
			lifecycleStatus: "error",
		});
		await process.retry();
		const completed = await process.runTurn({
			tools: [{ name: "done", arguments: { markdown: "# Completed" } }],
		});
		expect(completed.failure, JSON.stringify(completed.toolResults)).toBeNull();
		expect(completed.outcome).toBe("done");
		expect(completed.prompts.join("\n")).toContain("Produce a test result");
		expect(completed.turn).toMatchObject({ status: "succeeded", attemptNumber: 2 });
		await test.restart();
		expect(process.snapshot().turns).toHaveLength(2);
		expect(process.snapshot().process.lifecycleStatus).toBe("completed");
		const parent = await test.createProcess(llm, {
			position: { selectedTurnId: "work", lifecycleStatus: "waiting" },
		});
		const before = parent.snapshot().process;
		const retained = await parent.seedAcceptedTurn({
			turnId: "work",
			execution: { status: "succeeded", outcome: "done", markdown: "Retained" },
		});
		expect(parent.snapshot().process).toEqual(before);
		const running = await parent.seedAcceptedTurn({
			turnId: "work",
			execution: { status: "running" },
		});
		await test.restart();
		expect(parent.snapshot().turns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: retained.id,
					status: "succeeded",
					turnResultMarkdown: "Retained",
				}),
				expect.objectContaining({
					id: running.id,
					turnStartRecordId: expect.any(String),
					acceptedWorkerLeaseId: expect.any(String),
				}),
			]),
		);
	} finally {
		await test.close();
	}
}, 30000);

it("manual provider polling preserves startup and restart hooks", async () => {
	let polls = 0;
	let starts = 0;
	let poll: (() => Promise<unknown>) | undefined;
	const extension: LeitwerkExtensionModule = {
		manifest: { id: "polling-fixture", version: "1" },
		setupServer(api) {
			const deps = api.get(coreHostCapabilities.serverSetup);
			if (!deps || Array.isArray(deps)) throw new Error("Missing server setup");
			const provider = deps.polling.create({
				id: "fixture-poll",
				isEnabled: () => true,
				pollInterval: () => "1ms",
				async pollOnce() {
					polls++;
					return { created: [], errors: [] };
				},
			});
			poll = () => provider.poll();
			api.onStart(() => {
				starts++;
			});
		},
	};
	const test = await createExtensionIntegrationHarness({
		extensions: [extension],
		polling: "manual",
	});
	try {
		expect(starts).toBe(1);
		expect(polls).toBe(0);
		await poll?.();
		expect(polls).toBe(1);
		await test.restart();
		expect(starts).toBe(2);
		expect(polls).toBe(1);
		await poll?.();
		expect(polls).toBe(2);
	} finally {
		await test.close();
	}
});
