import {
	createTestProcessInstance,
	createTestProcessProject,
	createTestWorkerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it } from "vitest";
import { flow } from "./flow.js";

describe("flow automatic turns", () => {
	it("can wait on itself and expose external actions as graph edges", async () => {
		const source = {
			kind: "test.event",
			config: {},
			resolve: () => ({ key: "value" }),
		};
		const process = flow
			.process("awaitable_automatic")
			.displayName("Awaitable automatic")
			.entry("deliver")
			.codecs({
				params: { parse: () => ({}), serialize: (value) => value },
				state: { parse: () => ({}), serialize: (value) => value },
			})
			.initialState(() => ({}))
			.turn(
				flow
					.automatic("deliver")
					.description("Deliver")
					.run(() => ({ outcome: "awaiting" }))
					.outcome("awaiting", (outcome) => outcome.description("Await events").wait())
					.outcome("done", (outcome) => outcome.description("Done").complete())
					.externalAction("resume", source, (external) =>
						external.to("deliver").effect(({ state }) => ({ state })),
					)
					.externalAction("cancel", source, (external) => external.lifecycleStatus("aborted")),
			)
			.define();

		const deliver = process.turns.get("deliver")?.definition;
		expect(deliver).toMatchObject({
			kind: "automatic",
			externalActions: {
				resume: { to: "deliver", effect: expect.any(Function) },
				cancel: { lifecycleStatus: "aborted" },
			},
		});
		if (deliver?.kind !== "automatic") throw new Error("expected automatic turn");
		const waitEffect = deliver.outcomes?.awaiting?.effect;
		expect(await waitEffect?.({ ctx: {} as never, event: {} as never, turnId: "deliver", outcome: "awaiting" })).toEqual({
			processPatch: { lifecycleStatus: "waiting" },
		});
	});

	it("passes FlowAutomaticRunContext directly to run functions", async () => {
		let receivedFsPath = "";
		const turn = flow
			.automatic<{ prompt: string }, Record<string, never>>("finalize")
			.description("Finalize")
			.run((ctx) => {
				const repo = ctx.repo.get("repo");
				receivedFsPath = repo.fsPath;
				return { outcome: "done", params: { path: repo.workspaceClonePath } };
			})
			.outcome("done", (outcome) =>
				outcome.description("Done").requiredString("path", "The workspace path").complete(),
			);

		const result = await turn.definition.run(
			createTestWorkerProcessContext({
				process: createTestProcessInstance({ processId: "test_process" }),
				projects: [createTestProcessProject({ key: "repo", workBranch: "feature/test" })],
				params: { prompt: "Ship it" },
				state: {},
				workspaceRoot: "/tmp/process-workspace",
			}),
		);

		expect(result).toEqual({ outcome: "done", params: { path: "./repo" } });
		expect(receivedFsPath).toBe("/tmp/process-workspace/repo");
	});

	it("compiles automatic outcome routes and exposes markdown output to effects", async () => {
		const turn = flow
			.automatic<unknown, { summary: string | null }>("finalize")
			.description("Finalize")
			.run(() => ({ outcome: "done", markdown: "## Done" }))
			.outcome("dirty", (outcome) =>
				outcome.description("Dirty").stringArray("dirtyFiles", "Dirty files").to("commit_worktree"),
			)
			.outcome("done", (outcome) =>
				outcome
					.description("Done")
					.complete()
					.state(({ ctx }) => ({ summary: ctx.output?.content ?? null })),
			);

		expect(turn.definition.outcomes?.dirty).toMatchObject({
			to: "commit_worktree",
			parameters: { dirtyFiles: { type: "array", items: { type: "string" } } },
		});
		const effect = await turn.definition.outcomes?.done?.effect?.({
			ctx: {
				process: createTestProcessInstance(),
				projects: [],
				params: {},
				state: { summary: null },
				readSemanticTurnResultMarkdown: () => null,
				readProductTurnResultMarkdown: () => null,
			},
			event: {
				turnRecordId: "trn_1",
				turnId: "finalize",
				outcome: "done",
				params: {},
				turnResultMarkdown: "## Done",
			},
			turnId: "finalize",
			outcome: "done",
		});
		expect(effect).toEqual({ state: { summary: "## Done" } });
	});

	it("does not require a project unless the run function asks for one", async () => {
		const turn = flow
			.automatic<{ prompt: string }, Record<string, never>>("finalize")
			.description("Finalize")
			.run((ctx) => ({ outcome: "done", params: { prompt: ctx.params.prompt } }))
			.outcome("done", (outcome) => outcome.description("Done").complete());

		expect(
			await turn.definition.run(
				createTestWorkerProcessContext({
					process: createTestProcessInstance({ processId: "test_process" }),
					projects: [],
					params: { prompt: "Ship it" },
					state: {},
				}),
			),
		).toEqual({ outcome: "done", params: { prompt: "Ship it" } });
	});

	it("rejects project keys that would resolve outside the workspace root", () => {
		const turn = flow
			.automatic("finalize")
			.description("Finalize")
			.run((ctx) => ({ outcome: "done", params: { path: ctx.repo.get("../escape").fsPath } }))
			.outcome("done", (outcome) => outcome.description("Done").complete());

		expect(() =>
			turn.definition.run(
				createTestWorkerProcessContext({
					process: createTestProcessInstance({ processId: "test_process" }),
					projects: [createTestProcessProject({ key: "../escape" })],
					params: {},
					state: {},
					workspaceRoot: "/tmp/process-workspace",
				}),
			),
		).toThrow(/resolves outside/);
	});

	it("allows project keys that start with dots but remain inside the workspace root", async () => {
		const turn = flow
			.automatic("finalize")
			.description("Finalize")
			.run((ctx) => ({ outcome: "done", params: { path: ctx.repo.get("..repo").fsPath } }))
			.outcome("done", (outcome) => outcome.description("Done").complete());

		expect(
			turn.definition.run(
				createTestWorkerProcessContext({
					process: createTestProcessInstance({ processId: "test_process" }),
					projects: [createTestProcessProject({ key: "..repo" })],
					params: {},
					state: {},
					workspaceRoot: "/tmp/process-workspace",
				}),
			),
		).toEqual({ outcome: "done", params: { path: "/tmp/process-workspace/..repo" } });
	});

	it("rejects absolute project keys even when no workspace root is available", () => {
		const turn = flow
			.automatic("finalize")
			.description("Finalize")
			.run((ctx) => ({ outcome: "done", params: { path: ctx.repo.get("/tmp/repo").fsPath } }))
			.outcome("done", (outcome) => outcome.description("Done").complete());

		expect(() =>
			turn.definition.run(
				createTestWorkerProcessContext({
					process: createTestProcessInstance({ processId: "test_process" }),
					projects: [createTestProcessProject({ key: "/tmp/repo" })],
					params: {},
					state: {},
				}),
			),
		).toThrow(/must be a relative workspace path/);
	});

	it("fails clearly when a requested repo key is unavailable", async () => {
		const turn = flow
			.automatic("finalize")
			.description("Finalize")
			.run((ctx) => ({ outcome: "done", params: { key: ctx.repo.get("repo").key } }))
			.outcome("done", (outcome) => outcome.description("Done").complete());

		expect(() =>
			turn.definition.run(
				createTestWorkerProcessContext({
					process: createTestProcessInstance({ processId: "test_process" }),
					projects: [],
					params: {},
					state: {},
				}),
			),
		).toThrow(/requires project 'repo'/);
	});
});
