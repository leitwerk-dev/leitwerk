import type { ExternalWriteLogRepoLike } from "@leitwerk-dev/external-writes";
import {
	coreHostCapabilities,
	emptyParamsCodec,
	flow,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { createExtensionTestHarness } from "./process.js";
import { createProcessFixture, createProjectFixture } from "./process-fixtures.js";
import {
	createQuestionFixture,
	createQuestionRequestFixture,
} from "./supported-question-fixtures.js";

const codec = { parse: () => ({}), serialize: (value: Record<string, never>) => value };
function definition() {
	return flow
		.process("harness_process")
		.displayName("Harness process")
		.entry("analyze")
		.codecs({ params: emptyParamsCodec, state: codec })
		.initialState(() => ({}))
		.turn(
			flow
				.llm("analyze")
				.description("Analyze")
				.integrationTools("snapshot")
				.prepare(async (ctx) => {
					ctx.reportProgress({ title: "Preparing", steps: [] });
					return await ctx.callIntegrationTool("snapshot", {});
				})
				.buildPrompt((ctx) => `Analyze ${JSON.stringify(ctx.prepared)}`)
				.outcomeTool("done", (tool) => tool.description("Finish").complete()),
		)
		.define();
}

describe("supported process harness", () => {
	it("owns registration, preparation, prompt rendering, and cleanup", async () => {
		const lifecycle: string[] = [];
		const extension: LeitwerkExtensionModule = {
			manifest: { id: "harness-test", version: "1.0.0" },
			setupServer(api) {
				api.onStart(() => {
					lifecycle.push("start");
				});
				api.onStop(() => {
					lifecycle.push("stop");
				});
				api.tool({
					name: "snapshot",
					description: "Snapshot",
					parameters: {},
					execute: async () => ({ path: "snapshot" }),
				});
			},
		};
		const test = await createExtensionTestHarness({ extensions: [extension] });
		try {
			const process = test.process(definition());
			const result = await process.evaluateTurn("analyze", { responses: [{ outcome: "done" }] });
			expect(result.prompts).toEqual(['Analyze {"path":"snapshot"}']);
			expect(result.tools).toEqual([{ name: "snapshot", arguments: {} }]);
			expect(result.progress).toEqual([{ title: "Preparing", steps: [] }]);
			expect(result.completed).toEqual([{ outcome: "done" }]);
			expect(Object.isFrozen(result.completed)).toBe(true);
			expect(process.describe().turns).toMatchObject([
				{ id: "analyze", kind: "llm", description: "Analyze" },
			]);
			await expect(process.evaluateTurn("analyze")).rejects.toThrow("Script exhausted");
			await expect(
				process.evaluateTurn("analyze", { responses: [{ outcome: "unknown" }] }),
			).rejects.toThrow("Undeclared outcome");
			const effects = await process.evaluateOutcome("analyze", { outcome: "done" });
			expect(effects.transitions).toEqual([]);
			expect(process.describe().transitions).toEqual([
				expect.objectContaining({ lifecycleStatus: "completed" }),
			]);
		} finally {
			await test.close();
		}
		await test.close();
		expect(lifecycle).toEqual(["start", "stop"]);
		expect(() => test.process(definition())).toThrow("closed");
	});

	it("owns write receipts, replay identities, and asynchronous events", async () => {
		const delivered: string[] = [];
		const harness = await createExtensionTestHarness({
			extensions: [
				{
					manifest: { id: "writes-test", version: "1" },
					setupServer(api) {
						const deps = api.get(coreHostCapabilities.serverSetup);
						if (!deps || Array.isArray(deps)) throw new Error("Missing server setup");
						const writes = deps.externalWrites as ExternalWriteLogRepoLike;
						api.events.on("process_created", async (event) => {
							await Promise.resolve();
							delivered.push(event.instanceId);
						});
						api.tool({
							name: "save",
							description: "Save",
							parameters: {},
							async execute(ctx) {
								if (!writes.hasDedupKey(ctx.idempotencyKey))
									writes.record({
										instanceId: ctx.process.id,
										writeType: "save",
										dedupKey: ctx.idempotencyKey,
										metadata: { value: "saved" },
									});
								return { saved: true };
							},
						});
					},
				},
			],
		});
		try {
			const fixture = { id: "one", invocationId: "retry" };
			await harness.callTool("save", {}, fixture);
			const before = harness.writeReceipts();
			await harness.callTool("save", {}, fixture);
			expect(harness.writeReceipts()).toHaveLength(1);
			await harness.callTool("save", {}, { ...fixture, invocationId: "next" });
			const firstReceipt = {
				instanceId: "one",
				writeType: "save",
				dedupKey: "retry",
				metadata: { value: "saved" },
			};
			expect(before).toEqual([firstReceipt]);
			expect(harness.writeReceipts()).toEqual([
				firstReceipt,
				{ ...firstReceipt, dedupKey: "next" },
			]);
			expect(Object.isFrozen(before[0])).toBe(true);
			expect(harness.describeTools()).toEqual([
				{ name: "save", description: "Save", parameters: {} },
			]);
			const process = createProcessFixture({ id: "one" });
			await harness.emit("process_created", { instanceId: process.id, process, projects: [] });
			expect(delivered).toEqual(["one"]);
		} finally {
			await harness.close();
		}
	});

	it("runs automatic handlers and starts each evaluation from the fixture", async () => {
		const processDefinition = flow
			.process("automatic_fixture")
			.displayName("Automatic")
			.entry("finish")
			.codecs({
				params: emptyParamsCodec,
				state: { parse: (value) => value as { count: number }, serialize: (value) => value },
			})
			.initialState(() => ({ count: 0 }))
			.turn(
				flow
					.automatic<Record<string, never>, { count: number }>("finish")
					.description("Finish")
					.run(() => ({ outcome: "done", markdown: "Result" }))
					.outcome("done", (outcome) =>
						outcome
							.description("Done")
							.complete()
							.state(({ ctx }) => {
								ctx.state.count += 1;
								return ctx.state;
							}),
					),
			)
			.define();
		const test = await createExtensionTestHarness();
		try {
			const fixture = { state: { count: 4 } };
			const process = test.process(processDefinition, fixture);
			expect((await process.evaluateTurn("finish")).completed).toEqual([
				{ outcome: "done", markdown: "Result" },
			]);
			for (let evaluation = 0; evaluation < 2; evaluation++) {
				const result = await process.evaluateOutcome("finish", { outcome: "done" });
				expect(result.transitions).toEqual([{ state: { count: 5 } }]);
				expect(fixture).toEqual({ state: { count: 4 } });
			}
		} finally {
			await test.close();
		}
	});

	it("runs every cleanup hook after a startup or cleanup failure", async () => {
		const calls: string[] = [];
		await expect(
			createExtensionTestHarness({
				extensions: [
					{
						manifest: { id: "failed-start", version: "1" },
						setupServer(api) {
							api.onStop(() => {
								calls.push("first");
							});
							api.onStop(() => {
								throw new Error("cleanup");
							});
							api.onStop(() => {
								calls.push("last");
							});
							api.onStart(() => {
								throw new Error("startup");
							});
						},
					},
				],
			}),
		).rejects.toThrow("startup");
		expect(calls.sort()).toEqual(["first", "last"]);
	});
});

describe("supported fixtures", () => {
	it("validates definition-aware positions and correlates project references", () => {
		const process = createProcessFixture({ id: "parent" }, definition());
		expect(process.currentExecution).toBeNull();
		expect(createProjectFixture({ process }).instanceId).toBe("parent");
		expect(() =>
			createProcessFixture(
				{ position: { selectedTurnId: "missing", lifecycleStatus: "active" } },
				definition(),
			),
		).toThrow("Undeclared fixture turn");
	});
	it("derives request status, timestamps, and question identities", () => {
		const open = createQuestionRequestFixture({
			questions: [
				createQuestionFixture({ question: "First?" }),
				createQuestionFixture({ question: "Second?" }),
			],
		});
		expect(new Set(open.questions.map((q) => q.id)).size).toBe(2);
		expect(open).toMatchObject({ status: "open", answeredAt: null, cancelledAt: null });
		expect(
			createQuestionRequestFixture({ resolution: { status: "answered", answers: ["Yes"] } }),
		).toMatchObject({
			status: "answered",
			answers: ["Yes"],
			answeredAt: "2026-01-01T00:00:01.000Z",
		});
		expect(() =>
			createQuestionRequestFixture({
				process: { id: "one" },
				turn: { id: "turn", instanceId: "two" },
			}),
		).toThrow("another process");
	});
});
