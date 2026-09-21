import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExternalWriteLogRepoLike } from "@leitwerk-dev/external-writes";
import { coreHostCapabilities } from "@leitwerk-dev/process-sdk";
import { createProjectFixture } from "@leitwerk-dev/test-support/fixtures";
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
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
	const test = await createExtensionTestHarness({
		extensions: [
			{
				manifest: { id: "woodpecker-tools-test", version: "1" },
				setupServer(api) {
					const deps = api.get(coreHostCapabilities.serverSetup);
					if (!deps || Array.isArray(deps)) throw new Error("Missing server setup");
					registerWoodpeckerTools(
						api,
						{
							client(profile) {
								expect(profile).toBe("ci-profile");
								return client;
							},
						},
						deps.externalWrites as ExternalWriteLogRepoLike,
					);
				},
			},
		],
	});
	onTestFinished(() => test.close());
	const fixture = {
		id: "p",
		params: {},
		invocationId: "restart-retained",
		projects: [
			createProjectFixture({
				process: { id: "p" },
				key: "repo",
				metadata: { woodpecker: { owner: "team", repo: "independent", profile: "ci-profile" } },
			}),
		],
	};
	const args = { projectKey: "repo", pipelineNumber: pipeline.number };
	expect(
		await test.callTool(
			"woodpecker_get_step_logs",
			{ ...args, stepId: 1, tailLines: 1, maxBytes: 7 },
			fixture,
		),
	).toEqual({ logs: "timeout", truncated: true });
	await expect(test.callTool("woodpecker_restart_pipeline", args, fixture)).rejects.toThrow(
		"diagnosis",
	);
	for (const diagnosis of ["", " ", 1])
		await expect(
			test.callTool("woodpecker_restart_pipeline", { ...args, diagnosis }, fixture),
		).rejects.toThrow("non-empty string");
	const diagnosed = {
		...args,
		diagnosis: "Transient infrastructure",
		logEvidence: "network timeout",
	};
	await test.callTool("woodpecker_restart_pipeline", diagnosed, fixture);
	await test.callTool("woodpecker_restart_pipeline", diagnosed, fixture);
	expect(restart).toHaveBeenCalledTimes(1);
	expect(test.writeReceipts()).toContainEqual(
		expect.objectContaining({ dedupKey: "restart-retained" }),
	);
});
