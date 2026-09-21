import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IntegrationToolExecutionContext } from "@leitwerk-dev/process-sdk";
import { createInMemoryExternalWriteLog, createToolCollector } from "@leitwerk-dev/test-support";
import { expect, it } from "vitest";
import { LocalGitHubAdapter } from "./testing.js";
import { registerGitHubTools } from "./tools.js";

it("resumes comments, reactions, inline replies and issue finalization after lost responses", async ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "github-delivery-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	let adapter = new LocalGitHubAdapter({
		root,
		baseUrl: "http://127.0.0.1:18082",
		allowedOrganization: "leitwerk-dev",
		seeds: [{ owner: "leitwerk-dev", name: "test" }],
	});
	let repo = adapter.repo("leitwerk-dev", "test");
	const issue = adapter.createIssue(repo, { title: "Change" });
	adapter.git.run(repo.repository.ssh_url, ["branch", "feature", "main"]);
	const pr = await adapter.client().createPullRequest("leitwerk-dev", "test", {
		title: "Change",
		body: "",
		head: "feature",
		base: "main",
	});
	const feedback = adapter.addFeedback(repo, pr.number, {
		kind: "inline",
		body: "Please revise",
		author: "member",
	});
	const writes = createInMemoryExternalWriteLog();
	const { api, tools } = createToolCollector(writes);
	registerGitHubTools(api, { client: () => adapter.client() });
	const ctx = {
		process: { id: "p", paramsJson: JSON.stringify({ githubProfile: "legacy" }) },
		project: { instanceId: "p", metadata: { github: { owner: "leitwerk-dev", repo: "test" } } },
		idempotencyKey: "unused",
	} as IntegrationToolExecutionContext;
	for (const [toolName, operation, args] of [
		["github_add_issue_comment", "comment", { issueNumber: issue.number, body: "Opened PR" }],
		[
			"github_add_pull_request_feedback_reaction",
			"reaction",
			{ feedbackKind: "inline", feedbackId: feedback.id },
		],
		[
			"github_reply_to_pull_request_feedback",
			"reply",
			{
				pullRequestNumber: pr.number,
				feedbackKind: "inline",
				feedbackId: feedback.id,
				body: "Addressed",
			},
		],
		[
			"github_update_issue",
			"issue",
			{ issueNumber: issue.number, patch: { labels: ["done"], state: "closed" } },
		],
	] as const) {
		const tool = tools.get(toolName);
		if (!tool) throw new Error(`Missing tool ${toolName}`);
		adapter.failNextResponse(operation);
		const input = { projectKey: "repo", ...args, writeKey: toolName };
		const recovered = await tool.execute(ctx, input);
		expect(recovered).toBeDefined();
		adapter = new LocalGitHubAdapter({
			root,
			baseUrl: "http://127.0.0.1:18082",
			allowedOrganization: "leitwerk-dev",
		});
		repo = adapter.repo("leitwerk-dev", "test");
		await tool.execute(ctx, input);
		await tool.execute(ctx, input);
	}
	expect(repo.comments[issue.number]).toHaveLength(1);
	expect(repo.feedback[pr.number]).toHaveLength(2);
	expect(repo.reactions[`inline:${feedback.id}`]).toHaveLength(1);
	expect(repo.issues[0]).toMatchObject({ state: "closed", labels: [{ name: "done" }] });
	expect(writes.records).toHaveLength(4);
	expect(tools.has("github_resolve_release_lock")).toBe(false);
	await expect(
		tools.get("github_get_issue")?.execute(
			{
				...ctx,
				project: {
					...ctx.project,
					metadata: { github: { owner: "outside", repo: "test", profile: "local" } },
				} as never,
			},
			{ projectKey: "repo", issueNumber: issue.number },
		),
	).rejects.toThrow("leitwerk-dev");
});

it("preserves membership, label history and editor authorization across restart", async ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "github-membership-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const options = { root, baseUrl: "http://127.0.0.1:18082", allowedOrganization: "leitwerk-dev" };
	let adapter = new LocalGitHubAdapter({
		...options,
		seeds: [{ owner: "leitwerk-dev", name: "test" }],
	});
	const repo = adapter.repo("leitwerk-dev", "test");
	const issue = adapter.createIssue(repo, { title: "Change", author: "outsider" });
	adapter.setMembership("member", true);
	const event = adapter.setIssueLabel(repo, issue.number, "trigger", "member");
	adapter.git.run(repo.repository.ssh_url, ["branch", "feature", "main"]);
	const pr = await adapter.client().createPullRequest("leitwerk-dev", "test", {
		title: "Change",
		body: "",
		head: "feature",
		base: "main",
	});
	const feedback = adapter.addFeedback(repo, pr.number, {
		kind: "review",
		body: "Change notes",
		author: "member",
	});
	adapter.setMembership("leitwerk-bot", true);
	adapter.addFeedback(repo, pr.number, {
		kind: "conversation",
		body: "Bot feedback must be ignored regardless of login casing",
		author: "LEITWERK-BOT",
	});
	adapter.editFeedback(repo, pr.number, "review", feedback.id, "Unauthorized edit", "outsider");
	adapter = new LocalGitHubAdapter(options);
	expect(
		await adapter
			.client()
			.authorizedTrigger("leitwerk-dev", "test", issue.number, "trigger", "done"),
	).toMatchObject({ actor: "member", eventId: event.id });
	expect(
		await adapter.client().listActionablePullRequestFeedback("leitwerk-dev", "test", pr.number),
	).toEqual([]);
	adapter.setMembership("member", false);
	expect(
		await adapter
			.client()
			.authorizedTrigger("leitwerk-dev", "test", issue.number, "trigger", "done"),
	).toBeNull();
});
