import {
	createTestProcessInstance,
	createTestWorkerProcessContext,
} from "@leitwerk-dev/extension-runtime/testing";
import { describe, expect, it, vi } from "vitest";
import { flow } from "./flow.js";

describe("flow LLM turn preparation", () => {
	it("types and passes preparation data into the prompt", async () => {
		const turn = flow
			.llm<{ processRef: string }, Record<string, never>>("analyze")
			.description("Analyze")
			.integrationTools("download_snapshot")
			.prepare(async (ctx) => {
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
		const ctx = {
			...createTestWorkerProcessContext({
				process: createTestProcessInstance(),
				params: { processRef: "agt_source" },
				state: {},
			}),
			callIntegrationTool,
			reportProgress,
		};

		const prepared = await definition.prepare(ctx);
		expect(prepared).toEqual({ snapshotDir: "/tmp/snapshot" });
		expect(callIntegrationTool).toHaveBeenCalledWith("download_snapshot", {
			processRef: "agt_source",
		});
		expect(await definition.prompt({ ...ctx, prepared })).toBe("Analyze /tmp/snapshot");
		expect(reportProgress).toHaveBeenCalledOnce();
	});
});
