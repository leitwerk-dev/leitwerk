import {
	createTestProcessInstance,
	createTestWorkerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it, vi } from "vitest";
import { flow } from "./flow.js";

describe("flow LLM turn preparation", () => {
	it("resolves question availability from typed captured preparation", async () => {
		const turn = flow
			.llm<{ skipQuestions: boolean }, Record<string, never>>("plan")
			.description("Plan")
			.prepare(({ params }) => ({ skipQuestions: params.skipQuestions }))
			.askQuestions(({ prepared }) => !prepared.skipQuestions)
			.buildPrompt(() => "Plan the change")
			.publish("plan")
			.complete();
		for (const skipQuestions of [false, true]) {
			const ctx = createTestWorkerProcessContext({ params: { skipQuestions }, state: {} });
			const prepared = await turn.definition.prepare?.(ctx);
			expect(turn.definition.resolveAskQuestions?.({ ...ctx, prepared })).toBe(!skipQuestions);
		}
	});

	it("passes the captured scoped settings into preparation", async () => {
		const scopedSettings = {
			version: 1 as const,
			purpose: "example.analysis",
			context: { instance: "installation" },
			values: [{ key: "example.timeout_ms", value: 2_000, sources: [] }],
			instructions: [],
			explanations: [],
		};
		const turn = flow
			.llm("analyze")
			.description("Analyze")
			.prepare((ctx) => ({ timeoutMs: ctx.scopedSettings?.values[0]?.value }))
			.buildPrompt((ctx) => `Analyze within ${ctx.prepared.timeoutMs}ms`)
			.publish("analysis")
			.complete();
		const ctx = { ...createTestWorkerProcessContext(), scopedSettings };
		const prepared = await turn.definition.prepare?.(ctx);
		expect(prepared).toEqual({ timeoutMs: 2_000 });
		expect(await turn.definition.prompt({ ...ctx, prepared })).toBe("Analyze within 2000ms");
	});

	it("types and passes preparation data into the prompt", async () => {
		const turn = flow
			.llm<{ processRef: string }, Record<string, never>>("analyze")
			.description("Analyze")
			.integrationTools("download_snapshot")
			.prepare(async (ctx) => {
				ctx.reportDiagnostic({
					level: "info",
					code: "example.preparation",
					message: "Downloading",
				});
				ctx.reportProgress({
					title: "Preparation",
					steps: [{ id: "download", label: "Download", status: "in_progress" }],
				});
				return (await ctx.callIntegrationTool("download_snapshot", {
					processRef: ctx.params.processRef,
				})) as { snapshotDir: string };
			})
			.buildPrompt((ctx) => `Analyze ${ctx.prepared.snapshotDir}`)
			.publish("analysis")
			.complete();
		const definition = turn.definition;
		if (!definition.prepare) throw new Error("Expected LLM preparation");
		const callIntegrationTool = vi.fn(async () => ({ snapshotDir: "/tmp/snapshot" }));
		const reportProgress = vi.fn();
		const reportDiagnostic = vi.fn();
		const ctx = {
			...createTestWorkerProcessContext({
				process: createTestProcessInstance(),
				params: { processRef: "agt_source" },
				state: {},
			}),
			callIntegrationTool,
			reportProgress,
			reportDiagnostic,
		};

		const prepared = await definition.prepare(ctx);
		expect(prepared).toEqual({ snapshotDir: "/tmp/snapshot" });
		expect(callIntegrationTool).toHaveBeenCalledWith("download_snapshot", {
			processRef: "agt_source",
		});
		expect(await definition.prompt({ ...ctx, prepared })).toBe("Analyze /tmp/snapshot");
		expect(reportProgress).toHaveBeenCalledOnce();
		expect(reportDiagnostic).toHaveBeenCalledWith({
			level: "info",
			code: "example.preparation",
			message: "Downloading",
		});
	});
});
