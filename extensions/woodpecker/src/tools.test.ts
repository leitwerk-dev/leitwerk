import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { createInMemoryExternalWriteLog, createToolCollector } from "@leitwerk-dev/test-support";
import { expect, it, vi } from "vitest";
import { LocalWoodpeckerAdapter } from "./testing.js";
import { registerWoodpeckerTools } from "./tools.js";

it("uses CI-only project bindings, bounds logs, and durably replays diagnosed restarts", async ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "ci-tools-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const adapter = new LocalWoodpeckerAdapter({ root, baseUrl: "http://127.0.0.1:18082" });
	const repo = adapter.seed("team/independent");
	const pipeline = adapter.publish(repo, {
		branch: "feature",
		commit: "head",
		status: "failure",
		logs: "setup\nnetwork timeout",
	});
	const client = adapter.client();
	const restart = vi.spyOn(client, "restartPipeline");
	const { api, tools } = createToolCollector();
	const writes = createInMemoryExternalWriteLog();
	registerWoodpeckerTools(
		api,
		{
			client: (profile) => {
				expect(profile).toBe("ci-profile");
				return client;
			},
		},
		writes,
	);
	const ctx = {
		process: { id: "p", paramsJson: "{}" },
		project: {
			instanceId: "p",
			metadata: { woodpecker: { owner: "team", repo: "independent", profile: "ci-profile" } },
		},
		idempotencyKey: "restart-retained",
		signal: new AbortController().signal,
	} as IntegrationToolExecutionContext;
	const args = { projectKey: "repo", pipelineNumber: pipeline.number };
	expect(
		await tools
			.get("woodpecker_get_step_logs")
			?.execute(ctx, { ...args, stepId: 1, tailLines: 1, maxBytes: 7 }),
	).toEqual({ logs: "timeout", truncated: true });
	await expect(tools.get("woodpecker_restart_pipeline")?.execute(ctx, args)).rejects.toThrow(
		"diagnosis",
	);
	for (const diagnosis of ["", " ", 1])
		await expect(
			tools.get("woodpecker_restart_pipeline")?.execute(ctx, { ...args, diagnosis }),
		).rejects.toThrow("non-empty string");
	const diagnosed = {
		...args,
		diagnosis: "Transient infrastructure",
		logEvidence: "network timeout",
	};
	await tools.get("woodpecker_restart_pipeline")?.execute(ctx, diagnosed);
	await tools.get("woodpecker_restart_pipeline")?.execute(ctx, diagnosed);
	expect(restart).toHaveBeenCalledTimes(1);
	expect(writes.hasDedupKey("restart-retained")).toBe(true);
});
