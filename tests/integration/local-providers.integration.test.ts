import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import { LocalGitHubAdapter } from "@leitwerk-dev/github/testing";
import { LocalWoodpeckerAdapter } from "@leitwerk-dev/woodpecker/testing";
import { expect, test, vi } from "vitest";

test("local provider state survives restart with real Git feedback, conflicts, checks and release ancestry", async ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "local-providers-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Unexpected production network request");
	});
	onTestFinished(() => network.mockRestore());
	const options = { root, baseUrl: "http://127.0.0.1:18082", now: () => 1700000000000 };
	const github = new LocalGitHubAdapter(options);
	const repo = github.seed({
		owner: "independent",
		name: "project",
		files: { "notes.txt": "initial\n" },
	});
	const git = github.git;
	const directory = path.join(root, "seeds/independent--project");
	const commit = (file: string, contents: string, branch: string) => {
		writeFileSync(path.join(directory, file), contents);
		git.run(directory, ["add", "."]);
		git.run(directory, ["commit", "-m", "change notes"]);
		git.run(directory, ["push", "origin", branch]);
	};
	git.run(directory, ["switch", "-c", "feature"]);
	commit("notes.txt", "feature\n", "feature");
	const client = github.client();
	const pr = await client.createPullRequest("independent", "project", {
		title: "Review",
		body: "Review notes",
		head: "feature",
		base: "main",
	});
	github.addFeedback(repo, pr.number, {
		kind: "inline",
		body: "Explain this line",
		author: "reviewer",
		path: "notes.txt",
		line: 1,
	});
	expect(await client.listPullRequestFeedback("independent", "project", pr.number)).toEqual([
		expect.objectContaining({ kind: "inline", path: "notes.txt" }),
	]);
	github.setChecks(repo, {
		headSha: pr.head.sha,
		status: "failure",
		total: 1,
		failed: [{ name: "validation", conclusion: "failure", url: null }],
	});
	commit("notes.txt", "feature fixed\n", "feature");
	const fresh = await client.getPullRequest("independent", "project", pr.number);
	expect(fresh.head.sha).not.toBe(pr.head.sha);
	expect((await client.getCheckSummary("independent", "project", fresh.head.sha)).status).toBe(
		"pending",
	);
	git.run(directory, ["switch", "main"]);
	commit("base.txt", "base advanced\n", "main");
	expect(await client.getPullRequest("independent", "project", pr.number)).toMatchObject({
		mergeable: true,
		mergeable_state: "behind",
	});
	commit("notes.txt", "conflicting base\n", "main");
	expect(await client.getPullRequest("independent", "project", pr.number)).toMatchObject({
		mergeable: false,
		mergeable_state: "dirty",
	});
	expect(() => github.merge(repo, pr.number)).toThrow();
	// Repair using a real merge and commit, then publish the resulting head.
	git.run(directory, ["switch", "feature"]);
	try {
		git.run(directory, ["merge", "main", "--no-edit"]);
	} catch {
		/* Expected conflict. */
	}
	commit("notes.txt", "reconciled\n", "feature");
	github.merge(repo, pr.number);
	const merged = await client.getPullRequest("independent", "project", pr.number);
	const release = github.publishRelease(repo, {
		tag: "v1.0.0",
		ref: "main",
		assets: { "manifest.json": "public asset" },
	});
	expect(await client.isAncestor("independent", "project", merged.head.sha, release.tag_name)).toBe(
		true,
	);
	expect(await client.downloadReleaseAsset(release.assets[0])).toBe("public asset");
	const restarted = new LocalGitHubAdapter(options);
	expect(
		await restarted.client().getPullRequest("independent", "project", pr.number),
	).toMatchObject({ merged: true });
	expect(await restarted.client().downloadReleaseAsset(release.assets[0])).toBe("public asset");
	const forgejo = new LocalForgejoAdapter(options);
	const ticketRepo = forgejo.seed({ owner: "another-team", name: "tickets" });
	forgejo.state.failAfterIssueWrite = true;
	await expect(
		forgejo.client().createIssue("another-team", "tickets", { title: "Retained", body: "marker" }),
	).rejects.toThrow("response lost");
	const restored = new LocalForgejoAdapter(options);
	expect(await restored.client().listIssues("another-team", "tickets")).toHaveLength(1);
	expect(restored.repo("another-team", "tickets").repository.ssh_url).toBe(
		ticketRepo.repository.ssh_url,
	);
	const ci = new LocalWoodpeckerAdapter(options);
	const ciRepo = ci.seed("unrelated/ci-only");
	ci.publish(ciRepo, {
		branch: "main",
		commit: fresh.head.sha,
		status: "failure",
		event: "pull_request",
		logs: "old\n🌱🌱🌱🌱🌱",
	});
	const pipeline = (await ci.client().listPipelines(ciRepo.repository.id))[0];
	const logs = await ci.client().getStepLogs(ciRepo.repository.id, pipeline.number, 1, 1, 9);
	expect(Buffer.byteLength(logs.logs)).toBeLessThanOrEqual(9);
	expect(logs.truncated).toBe(true);
	expect(new LocalWoodpeckerAdapter(options).state.repositories[0].pipelines[0].commit).toBe(
		fresh.head.sha,
	);
	expect(network).not.toHaveBeenCalled();
}, 45000);
