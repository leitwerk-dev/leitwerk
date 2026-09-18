import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDatabase, createAllRepos, createDatabase } from "@leitwerk-dev/server";
import { createToolCollector } from "@leitwerk-dev/test-support";
import { createTestDiagnostics } from "@leitwerk-dev/test-support/local-git";
import { expect, it } from "vitest";
import { pullRequestArgs, toolContext } from "./testing/tool-fixture.js";
import { LocalGitHubAdapter } from "./testing.js";
import { registerGitHubTools } from "./tools.js";

it("retains one reconciled PR and SQLite receipt across provider and repository reopening", async ({
	onTestFinished,
	onTestFailed,
}) => {
	const trace = createTestDiagnostics("github-tools recovery");
	onTestFailed(() => trace.report());
	await trace.run(async () => {
		const root = mkdtempSync(path.join(tmpdir(), "github-tools-recovery-"));
		let db: ReturnType<typeof createDatabase> | undefined;
		onTestFinished(() => {
			if (db) closeDatabase(db);
			rmSync(root, { recursive: true, force: true });
		});
		trace.mark("seed.start");
		let adapter = new LocalGitHubAdapter({
			root,
			baseUrl: "https://github.invalid",
			seeds: [{ owner: "team", name: "one" }],
		});
		const bare = adapter.repo("team", "one").repository.ssh_url;
		const baseSha = adapter.git.head(bare, "main");
		const tree = adapter.git.run(bare, ["rev-parse", "main^{tree}"]);
		const headSha = adapter.git.run(bare, [
			"commit-tree",
			tree,
			"-p",
			baseSha,
			"-m",
			"Feature commit",
		]);
		adapter.git.run(bare, ["update-ref", "refs/heads/feature", headSha]);
		const sqlitePath = path.join(root, "receipts.sqlite");
		db = createDatabase({ sqlitePath });
		let repos = createAllRepos(db);
		const process = repos.processes.create({ processId: "test", lifecycleStatus: "active" });
		const ctx = toolContext(process.id);
		const register = () => {
			const { api, tools } = createToolCollector();
			registerGitHubTools(api, { client: () => adapter.client() }, repos.externalWrites);
			const tool = tools.get("github_ensure_pull_request");
			if (!tool) throw new Error("Missing PR tool");
			return tool;
		};
		trace.mark("reconcile.start");
		adapter.state.failAfterPullRequestWrite = true;
		const pr = await register().execute(ctx, pullRequestArgs);
		expect(pr).toMatchObject({ head: { sha: headSha }, base: { sha: baseSha } });
		const receipts = repos.externalWrites.listByInstance(process.id);
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatchObject({
			dedupKey: ctx.idempotencyKey,
			writeType: "github.ensure_pr",
			metadata: { number: adapter.repo("team", "one").pulls[0].number },
		});
		trace.mark("reopen.start");
		closeDatabase(db);
		db = undefined;
		adapter = new LocalGitHubAdapter({ root, baseUrl: "https://github.invalid" });
		db = createDatabase({ sqlitePath });
		repos = createAllRepos(db);
		await expect(register().execute(ctx, pullRequestArgs)).resolves.toEqual(pr);
		expect(adapter.repo("team", "one").pulls).toHaveLength(1);
		expect(repos.externalWrites.listByInstance(process.id)).toEqual(receipts);
		trace.mark("reopen.end");
	});
}, 60_000);
