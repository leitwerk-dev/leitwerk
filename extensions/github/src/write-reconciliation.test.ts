import { type IntegrationToolExecutionContext, matchesPatch } from "@leitwerk-dev/process-sdk";
import { createInMemoryExternalWriteLog, createToolCollector } from "@leitwerk-dev/test-support";
import { afterEach, expect, it, vi } from "vitest";
import { GitHubClient } from "./client.js";
import { registerGitHubTools } from "./tools.js";

afterEach(() => vi.unstubAllGlobals());
it("recovers a lost inline reply only in its original thread", async () => {
	const writes = createInMemoryExternalWriteLog();
	const { api, tools } = createToolCollector(writes);

	const client = new GitHubClient({
		apiBaseUrl: "https://github.test",
		token: "test",
		botLogin: "bot",
	});
	registerGitHubTools(api, { client: () => client });
	const ctx = {
		process: { id: "p" },
		project: {
			instanceId: "p",
			metadata: { github: { owner: "team", repo: "repo", profile: "default" } },
		},
		idempotencyKey: "key",
		signal: new AbortController().signal,
	} as unknown as IntegrationToolExecutionContext;
	const replies = [{ id: 1, in_reply_to_id: 99, body: "<!-- leitwerk-write:p:key -->" }];
	let posts = 0;
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		expect(url).toContain("/repos/team/repo/pulls/7/comments");
		if (init.method === "POST") {
			expect(url).toContain("/comments/8/replies");
			posts++;
			replies.push({ id: 2, in_reply_to_id: 8, body: JSON.parse(String(init.body)).body });
			throw new Error("lost response");
		}
		return Response.json(replies);
	});
	const tool = tools.get("github_reply_to_pull_request_feedback");
	if (!tool) throw new Error("missing tool");
	const args = { pullRequestNumber: 7, feedbackKind: "inline", feedbackId: 8, body: "Fixed" };
	expect(await tool.execute(ctx, args)).toMatchObject({ id: 2 });
	expect(await tool.execute(ctx, args)).toMatchObject({ id: 2 });
	expect(posts).toBe(1);
});
it("compares normalized labels and every requested update field", () => {
	const current = { title: "Updated", state: "closed", labels: [{ name: "b" }, { name: "a" }] };
	expect(matchesPatch(current, { labels: ["a", "b", "a"], title: "Updated" })).toBe(true);
	expect(matchesPatch(current, { labels: ["a", "b"], title: "Old" })).toBe(false);
});
