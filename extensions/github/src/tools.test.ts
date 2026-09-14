import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExternalWriteLogRecordInput } from "@leitwerk-dev/external-writes";
import type {
	IntegrationToolDefinition,
	IntegrationToolExecutionContext,
	ServerExtensionAPI,
} from "@leitwerk-dev/process-sdk";
import { expect, it, vi } from "vitest";
import { LocalGitHubAdapter } from "./testing.js";
import { registerGitHubTools } from "./tools.js";

it("authorizes project bindings and reconciles a lost PR response into one durable receipt", async ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "github-tools-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const adapter = new LocalGitHubAdapter({
		root,
		baseUrl: "http://127.0.0.1:18082",
		seeds: [
			{ owner: "team", name: "one" },
			{ owner: "team", name: "two" },
		],
	});
	const repo = adapter.repo("team", "one");
	adapter.git.run(repo.repository.ssh_url, ["branch", "feature", "main"]);
	const tools = new Map<string, IntegrationToolDefinition>();
	const writes = new Map<string, ExternalWriteLogRecordInput>();
	const client = vi.fn((profile: string) => {
		if (profile !== "first") throw new Error("Wrong profile");
		return adapter.client();
	});
	registerGitHubTools(
		{ tool: (tool: IntegrationToolDefinition) => tools.set(tool.name, tool) } as ServerExtensionAPI,
		{ client },
		{
			hasDedupKey: (key) => writes.has(key),
			record: (write) => writes.set(write.dedupKey, write),
		},
	);
	const ctx = {
		process: { id: "p", paramsJson: "{}" },
		project: {
			instanceId: "p",
			metadata: { github: { owner: "team", repo: "one", profile: "first" } },
		},
		idempotencyKey: "retained-pr-key",
		signal: new AbortController().signal,
	} as IntegrationToolExecutionContext;
	const tool = tools.get("github_ensure_pull_request");
	const args = {
		projectKey: "one",
		owner: "attacker",
		repo: "two",
		profile: "other",
		title: "A change",
		body: "Review",
		head: "feature",
		base: "main",
	};
	adapter.state.failAfterPullRequestWrite = true;
	await expect(tool?.execute(ctx, args)).resolves.toMatchObject({ number: expect.any(Number) });
	expect(writes.get("retained-pr-key")).toMatchObject({
		writeType: "github.ensure_pr",
		metadata: { number: repo.pulls[0].number },
	});
	await tool?.execute(ctx, args);
	expect(repo.pulls).toHaveLength(1);
	expect(adapter.repo("team", "two").pulls).toHaveLength(0);
	expect(tools.has("github_resolve_release_lock")).toBe(false);
	const comment = tools.get("github_add_pull_request_comment");
	const commentCtx = { ...ctx, idempotencyKey: "comment-key" };
	const commentArgs = {
		projectKey: "one",
		pullRequestNumber: repo.pulls[0].number,
		body: "Reviewed",
	};
	await comment?.execute(commentCtx, commentArgs);
	await comment?.execute(commentCtx, commentArgs);
	expect(repo.comments[repo.pulls[0].number]).toHaveLength(1);
	const update = tools.get("github_update_pull_request");
	const updateCtx = { ...ctx, idempotencyKey: "update-key" };
	await update?.execute(updateCtx, { ...commentArgs, patch: { title: "Updated" } });
	await update?.execute(updateCtx, { ...commentArgs, patch: { title: "Should not replay" } });
	expect(repo.pulls[0].title).toBe("Updated");
	client.mockClear();
	await expect(
		tool?.execute(
			{
				...ctx,
				project: {
					...ctx.project,
					instanceId: "other",
				} as IntegrationToolExecutionContext["project"],
			},
			args,
		),
	).rejects.toThrow("authorized");
	expect(client).not.toHaveBeenCalled();
	const restarted = new LocalGitHubAdapter({ root, baseUrl: "http://127.0.0.1:18082" });
	expect(await restarted.client().listPullRequests("team", "one", "all")).toHaveLength(1);
});
