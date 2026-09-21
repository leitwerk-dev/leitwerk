import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectFixture } from "@leitwerk-dev/test-support/fixtures";
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
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
	const client = vi.fn((profile: string) => {
		if (profile !== "first") throw new Error("Wrong profile");
		return adapter.client();
	});
	const test = await createExtensionTestHarness({
		extensions: [
			{
				manifest: { id: "github-tools-test", version: "1" },
				setupServer(api) {
					registerGitHubTools(api, { client });
				},
			},
		],
	});
	onTestFinished(() => test.close());
	const fixture = {
		id: "p",
		params: {},
		invocationId: "retained-pr-key",
		projects: [
			createProjectFixture({
				process: { id: "p" },
				key: "one",
				workBranch: "feature",
				baseBranch: "main",
				metadata: { github: { owner: "team", repo: "one", profile: "first" } },
			}),
		],
	};
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
	await expect(test.callTool("github_ensure_pull_request", args, fixture)).resolves.toMatchObject({
		number: expect.any(Number),
	});
	expect(test.writeReceipts()).toMatchObject([
		{
			dedupKey: "retained-pr-key",
			writeType: "github.ensure_pr",
			metadata: { number: repo.pulls[0].number },
		},
	]);
	await test.callTool("github_ensure_pull_request", args, fixture);
	expect(repo.pulls).toHaveLength(1);
	expect(adapter.repo("team", "two").pulls).toHaveLength(0);
	expect(test.describeTools().some((t) => t.name === "github_resolve_release_lock")).toBe(false);
	const commentFixture = { ...fixture, invocationId: "comment-key" };
	const commentArgs = {
		projectKey: "one",
		pullRequestNumber: repo.pulls[0].number,
		body: "Reviewed",
	};
	await test.callTool("github_add_pull_request_comment", commentArgs, commentFixture);
	await test.callTool("github_add_pull_request_comment", commentArgs, commentFixture);
	expect(repo.comments[repo.pulls[0].number]).toHaveLength(1);
	const updateFixture = { ...fixture, invocationId: "update-key" };
	await test.callTool(
		"github_update_pull_request",
		{ ...commentArgs, patch: { title: "Updated" } },
		updateFixture,
	);
	await test.callTool(
		"github_update_pull_request",
		{ ...commentArgs, patch: { title: "Should not replay" } },
		updateFixture,
	);
	expect(repo.pulls[0].title).toBe("Updated");
	client.mockClear();
	await expect(
		test.callTool("github_ensure_pull_request", args, {
			...fixture,
			projects: [{ ...fixture.projects[0], instanceId: "other" }],
		}),
	).rejects.toThrow("another process");
	expect(client).not.toHaveBeenCalled();
	const restarted = new LocalGitHubAdapter({ root, baseUrl: "http://127.0.0.1:18082" });
	expect(await restarted.client().listPullRequests("team", "one", "all")).toHaveLength(1);
}, 30_000);
