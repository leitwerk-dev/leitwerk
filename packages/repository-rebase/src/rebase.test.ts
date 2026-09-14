import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	prepareRebase,
	publishRebase,
	type RebaseInput,
	startRebase,
	verifyRebase,
} from "./git.js";

function git(path: string, ...args: string[]) {
	const env = { ...process.env };
	for (const name of [
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_AUTHOR_DATE",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
		"GIT_COMMITTER_DATE",
	])
		delete env[name];
	return execFileSync("git", args, {
		cwd: path,
		encoding: "utf8",
		env: {
			...env,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_EDITOR: "true",
		},
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
function fixture(conflicting = true) {
	const root = mkdtempSync(join(tmpdir(), "rebase-test-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	git(root, "init", "--bare", "remote.git");
	git(root, "clone", "remote.git", "work");
	const path = join(root, "work");
	git(path, "config", "commit.gpgsign", "false");
	git(path, "config", "user.name", "Original Author");
	git(path, "config", "user.email", "author@example.test");
	function commitFile(file: string, content: string, message: string, ...args: string[]) {
		writeFileSync(join(path, file), content);
		git(path, "add", ".");
		git(path, "commit", "-m", message, ...args);
		git(path, "push", "origin", "HEAD");
	}
	git(path, "checkout", "-b", "main");
	commitFile("file", "original\n", "initial");
	git(path, "checkout", "-b", "work");
	commitFile("file", "feature\n", "feature", "--signoff");
	const headSha = git(path, "rev-parse", "HEAD");
	git(path, "checkout", "main");
	commitFile(conflicting ? "file" : "other", "base\n", "base");
	const baseSha = git(path, "rev-parse", "HEAD");
	git(path, "checkout", "work");
	const input: RebaseInput = {
		projectKey: "repo",
		path,
		workBranch: "work",
		conflict: {
			owner: "owner",
			repo: "repo",
			prNumber: 1,
			headBranch: "work",
			baseBranch: "main",
			headSha,
			baseSha,
			url: "https://git.test/owner/repo/pulls/1",
		},
	};
	return { input, root, path };
}
function resolve(input: RebaseInput) {
	writeFileSync(join(input.path, "file"), "feature and base\n");
	git(input.path, "add", "file");
	git(input.path, "rebase", "--continue");
}
describe("repository rebase with real remotes", () => {
	it("rejects changed origin and push endpoints after preparation", () => {
		const { input, path, root } = fixture(false);
		startRebase(input);
		git(path, "remote", "set-url", "--push", "origin", join(root, "elsewhere.git"));
		expect(() => publishRebase(input)).toThrow("origin changed");
		git(path, "config", "--unset", "remote.origin.pushurl");
		git(path, "remote", "set-url", "origin", join(root, "elsewhere.git"));
		expect(() => startRebase(input)).toThrow("origin changed");
	});
	it.each([false, true])("rejects a rewritten base (already prepared: %s)", (prepared) => {
		const { input, path } = fixture(false);
		if (prepared) prepareRebase(input);
		git(path, "push", "--force", "origin", `${git(path, "rev-parse", "main^")}:refs/heads/main`);
		expect(() => (prepared ? startRebase(input) : prepareRebase(input))).toThrow();
	});
	it("rejects changed evidence branches and wrong branches after preparation", () => {
		const { input, path } = fixture(false);
		startRebase(input);
		expect(() =>
			prepareRebase({ ...input, conflict: { ...input.conflict, headBranch: "other" } }),
		).toThrow("tracked work branch");
		expect(() =>
			publishRebase({ ...input, conflict: { ...input.conflict, baseBranch: "other" } }),
		).toThrow("base branch changed");
		git(path, "checkout", "main");
		expect(() => publishRebase(input)).toThrow("tracked work branch");
	});
	it("loads retained metadata written before origin identity fields existed", () => {
		const { input, path } = fixture();
		startRebase(input);
		const file = join(path, ".git/leitwerk-rebase.json");
		const stored = JSON.parse(readFileSync(file, "utf8"));
		delete stored.originUrl;
		delete stored.originPushUrl;
		delete stored.baseBranch;
		writeFileSync(file, JSON.stringify(stored));
		expect(startRebase(input).originalHead).toBe(input.conflict.headSha);
		resolve(input);
		expect(publishRebase(input).changed).toBe(true);
	});
	it("resumes an interrupted conflict, preserves authors and sign-offs, and retries publication after a lost response", () => {
		const { input, path } = fixture();
		expect(startRebase(input).status).toBe("rebasing");
		expect(() => verifyRebase(input)).toThrow("incomplete");
		expect(startRebase(input).originalHead).toBe(input.conflict.headSha);
		resolve(input);
		const result = verifyRebase(input);
		expect(result.changed).toBe(true);
		expect(git(path, "show", "-s", "--format=%an")).toBe("Original Author");
		expect(git(path, "show", "-s", "--format=%B")).toContain(
			"Signed-off-by: Original Author <author@example.test>",
		);
		expect(publishRebase(input).headSha).toBe(result.headSha);
		expect(publishRebase(input).headSha).toBe(result.headSha);
	});
	it("rejects unresolved and dirty results", () => {
		const { input, path } = fixture();
		startRebase(input);
		expect(() => publishRebase(input)).toThrow("incomplete");
		resolve(input);
		writeFileSync(join(path, "file"), "dirty");
		expect(() => publishRebase(input)).toThrow("clean worktree");
	});
	it("rejects a concurrent push against the pre-repair lease", () => {
		const { input, root } = fixture();
		startRebase(input);
		resolve(input);
		git(root, "clone", "--branch", "work", "remote.git", "other");
		const other = join(root, "other");
		git(other, "config", "user.name", "Other");
		git(other, "config", "user.email", "other@example.test");
		git(other, "commit", "--allow-empty", "-m", "concurrent");
		git(other, "push", "origin", "work");
		expect(() => publishRebase(input)).toThrow("Concurrent remote change");
	});
	it("does not rewrite a stale conflict report that merges cleanly", () => {
		const { input } = fixture(false);
		expect(startRebase(input).status).toBe("clean");
		expect(publishRebase(input)).toMatchObject({ headSha: input.conflict.headSha, changed: false });
	});
	it("rebases clean but behind branches and publishes with the original lease", () => {
		const { input, path } = fixture(false);
		input.conflict.reason = "behind";
		expect(startRebase(input).status).toBe("rebasing");
		const result = publishRebase(input);
		expect(result.changed).toBe(true);
		expect(git(path, "merge-base", "--is-ancestor", input.conflict.baseSha, result.headSha)).toBe(
			"",
		);
		expect(readFileSync(join(path, "other"), "utf8")).toBe("base\n");
		expect(publishRebase(input).headSha).toBe(result.headSha);
	});
	it("does not rewrite a behind report when the base is already incorporated", () => {
		const { input, path } = fixture(false);
		git(path, "rebase", "main");
		git(path, "push", "--force-with-lease", "origin", "work");
		input.conflict.headSha = git(path, "rev-parse", "HEAD");
		input.conflict.reason = "behind";
		expect(startRebase(input).status).toBe("clean");
		expect(publishRebase(input).changed).toBe(false);
	});
	it("retains the original head before rebase starts and rejects an aborted repair", () => {
		const { input, path } = fixture();
		prepareRebase(input);
		expect(
			JSON.parse(readFileSync(join(path, ".git/leitwerk-rebase.json"), "utf8")).originalHead,
		).toBe(input.conflict.headSha);
		startRebase(input);
		git(path, "rebase", "--abort");
		expect(() => verifyRebase(input)).toThrow();
	});
	it("rejects the wrong branch and remote changes before preparation", () => {
		const { input, path } = fixture();
		git(path, "checkout", "main");
		expect(() => startRebase(input)).toThrow("tracked work branch");
		git(path, "checkout", "work");
		git(path, "commit", "--allow-empty", "-m", "unexpected");
		git(path, "push", "origin", "work");
		expect(() => startRebase(input)).toThrow("changed before repair");
	});
});
