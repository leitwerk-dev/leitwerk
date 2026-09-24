import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectFixture } from "@leitwerk-dev/test-support/fixtures";
import { createExtensionTestHarness } from "@leitwerk-dev/test-support/process";
import { expect, it } from "vitest";
import { LocalGitHubAdapter } from "./testing.js";
import { registerGitHubTools } from "./tools.js";

it("reconciles a lost PR response and preserves the PR across provider restart", async ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "github-tools-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const adapter = new LocalGitHubAdapter({
		root,
		baseUrl: "http://127.0.0.1:18082",
		seeds: [{ owner: "team", name: "one" }],
	});
	const repo = adapter.repo("team", "one");
	adapter.git.run(repo.repository.ssh_url, ["branch", "feature", "main"]);
	const test = await createExtensionTestHarness({
		extensions: [
			{
				manifest: { id: "github-tools-test", version: "1" },
				setupServer(api) {
					registerGitHubTools(api, { client: () => adapter.client() });
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
	const restarted = new LocalGitHubAdapter({ root, baseUrl: "http://127.0.0.1:18082" });
	expect(await restarted.client().listPullRequests("team", "one", "all")).toMatchObject([
		{ number: repo.pulls[0].number, title: "A change" },
	]);
}, 30_000);
