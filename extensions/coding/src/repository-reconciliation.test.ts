import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import { afterEach, describe, expect, it } from "vitest";
import { commitAndPushWorkBranch } from "./finalization-git.js";
import {
	readPublicationReceipt,
	savePublicationReceipt,
} from "./repository-publication-receipt.js";
import {
	ConcurrentRebaseSourceError,
	publishRebase,
	type RebaseInput,
	startRebase,
	verifyRebase,
} from "./repository-rebase/git.js";
import {
	prepareInitialRepository,
	reconcilePublicationRepository,
	reconcileRepository,
	recordRepositoryPublication,
	retainConcurrentRebase,
} from "./repository-reconciliation.js";

const roots: string[] = [];
function git(cwd: string, ...args: string[]) {
	return execFileSync(
		resolveGitBinary(),
		["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
		{
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_EDITOR: "true" },
		},
	).trim();
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "repository-reconciliation-"));
	roots.push(root);
	const bare = join(root, "remote.git");
	git(root, "init", "--bare", bare);
	const dev = join(root, "developer");
	git(root, "clone", bare, dev);
	writeFileSync(join(dev, "file.txt"), "original\n");
	writeFileSync(join(dev, ".gitignore"), "ignored.txt\n");
	git(dev, "add", ".");
	git(dev, "commit", "-m", "seed");
	git(dev, "branch", "-M", "work");
	git(dev, "push", "origin", "work");
	const baselineSha = git(dev, "rev-parse", "HEAD");
	const local = join(root, "local");
	git(root, "clone", "-b", "work", bare, local);
	const input = {
		projectKey: "repo",
		repoPath: local,
		workBranch: "work",
		baselineSha,
		gitIdentity: { name: "Reconciliation Bot", email: "reconciliation@example.test" },
	};
	const commit = (directory: string, file: string, content: string) => {
		writeFileSync(join(directory, file), content);
		git(directory, "add", "--all");
		git(directory, "commit", "-m", `change ${file}`);
		return git(directory, "rev-parse", "HEAD");
	};
	const push = () => git(dev, "push", "origin", "work");
	return { root, bare, dev, local, input, commit, push };
}
function attemptPublication(f: ReturnType<typeof fixture>, candidate: string) {
	savePublicationReceipt(join(f.local, ".git"), {
		branch: "work",
		origin: f.bare,
		pushOrigin: f.bare,
		expectedHead: f.input.baselineSha,
		candidate,
		status: "attempting",
	});
}
function targetRepair(
	f: ReturnType<typeof fixture>,
	headSha: string,
	baseSha: string,
	url: string,
): RebaseInput {
	return {
		projectKey: "repo",
		path: f.local,
		workBranch: "work",
		conflict: {
			owner: "team",
			repo: "repo",
			prNumber: 1,
			headBranch: "work",
			baseBranch: "target",
			headSha,
			baseSha,
			url,
			reason: "behind",
		},
	};
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repository reconciliation", { timeout: 30_000 }, () => {
	it("adopts the current remote without creating local changes", () => {
		const f = fixture();
		const remote = f.commit(f.dev, "remote.txt", "developer\n");
		f.push();
		expect(reconcileRepository(f.input)).toEqual({
			status: "ready",
			remoteHead: remote,
			headSha: remote,
			changed: true,
		});
		expect(git(f.local, "status", "--porcelain")).toBe("");
		expect(reconcileRepository(f.input).changed).toBe(false);
	});

	it("adopts a rewritten remote without resurrecting previously published commits", () => {
		const f = fixture();
		const obsolete = f.commit(f.dev, "obsolete.txt", "remove me\n");
		f.push();
		git(f.local, "pull", "--ff-only");
		recordRepositoryPublication(f.input, obsolete);
		git(f.dev, "reset", "--hard", f.input.baselineSha);
		const rewritten = f.commit(f.dev, "new.txt", "rebased\n");
		git(f.dev, "push", "--force", "origin", "work");
		expect(reconcileRepository(f.input).headSha).toBe(rewritten);
		expect(existsSync(join(f.local, "obsolete.txt"))).toBe(false);
	});

	it("preserves unpublished commits and exact staged/unstaged/untracked distinctions", () => {
		const f = fixture();
		f.commit(f.local, "local.txt", "committed\n");
		git(
			f.local,
			"commit",
			"--amend",
			"--no-edit",
			"--author=Original Developer <author@example.test>",
			"--trailer",
			"Signed-off-by: Original Developer <author@example.test>",
		);
		const originalAuthor = git(f.local, "log", "-1", "--format=%an%n%ae");
		writeFileSync(join(f.local, "file.txt"), "staged\n");
		git(f.local, "add", "file.txt");
		writeFileSync(join(f.local, "file.txt"), "unstaged\n");
		writeFileSync(join(f.local, "untracked.txt"), "untracked\n");
		f.commit(f.dev, "remote.txt", "developer\n");
		f.push();
		const result = reconcileRepository(f.input);
		expect(result.status).toBe("ready");
		expect(readFileSync(join(f.local, "remote.txt"), "utf8")).toBe("developer\n");
		expect(git(f.local, "show", "HEAD:local.txt")).toBe("committed");
		expect(git(f.local, "log", "-1", "--format=%an%n%ae%n%cn%n%ce")).toBe(
			`${originalAuthor}\nReconciliation Bot\nreconciliation@example.test`,
		);
		expect(git(f.local, "log", "-1", "--format=%B")).toContain(
			"Signed-off-by: Original Developer <author@example.test>",
		);
		expect(git(f.local, "show", ":file.txt")).toBe("staged");
		expect(readFileSync(join(f.local, "file.txt"), "utf8")).toBe("unstaged\n");
		expect(git(f.local, "status", "--porcelain")).toContain("?? untracked.txt");
		expect(git(f.local, "log", "--format=%s")).not.toContain("checkpoint");
	});

	it("replays only the unpublished delta after a developer force-push", () => {
		const f = fixture();
		const published = f.commit(f.dev, "old.txt", "published\n");
		f.push();
		git(f.local, "pull", "--ff-only");
		recordRepositoryPublication(f.input, published);
		f.commit(f.local, "local.txt", "unpublished\n");
		git(f.dev, "reset", "--hard", f.input.baselineSha);
		f.commit(f.dev, "new.txt", "rewritten\n");
		git(f.dev, "push", "--force", "origin", "work");
		reconcileRepository(f.input);
		expect(existsSync(join(f.local, "old.txt"))).toBe(false);
		expect(git(f.local, "show", "HEAD:local.txt")).toBe("unpublished");
	});

	it("retains recoverable checkpoints and resumes a conflict after worker replacement", () => {
		const f = fixture();
		f.commit(f.local, "file.txt", "local\n");
		f.commit(f.dev, "file.txt", "remote\n");
		f.push();
		expect(reconcileRepository(f.input).status).toBe("conflicts");
		expect(reconcileRepository(f.input).status).toBe("conflicts");
		const record = JSON.parse(
			readFileSync(join(f.local, ".git/leitwerk-reconciliation.json"), "utf8"),
		);
		expect(git(f.local, "show", `${record.operation.head}:file.txt`)).toBe("local");
		writeFileSync(join(f.local, "file.txt"), "remote and local\n");
		git(f.local, "add", "file.txt");
		git(f.local, "rebase", "--continue");
		expect(reconcileRepository(f.input).status).toBe("ready");
		expect(readFileSync(join(f.local, "file.txt"), "utf8")).toBe("remote and local\n");
		expect(git(f.local, "log", "--format=%s")).not.toContain("checkpoint");
	});

	it("retains untracked file collisions instead of overwriting either version", () => {
		const f = fixture();
		writeFileSync(join(f.local, "collision.txt"), "local\n");
		f.commit(f.dev, "collision.txt", "remote\n");
		f.push();
		expect(reconcileRepository(f.input).status).toBe("conflicts");
		const record = JSON.parse(
			readFileSync(join(f.local, ".git/leitwerk-reconciliation.json"), "utf8"),
		);
		expect(git(f.local, "show", `${record.operation.work}:collision.txt`)).toBe("local");
		expect(git(f.local, "show", `${record.operation.remote}:collision.txt`)).toBe("remote");
	});

	it("blocks ignored-file collisions before touching the checkout", () => {
		const f = fixture();
		writeFileSync(join(f.local, "ignored.txt"), "private\n");
		writeFileSync(join(f.dev, "ignored.txt"), "remote\n");
		git(f.dev, "add", "--force", "ignored.txt");
		git(f.dev, "commit", "-m", "track ignored path");
		f.push();
		expect(() => reconcileRepository(f.input)).toThrow(/ignored files/);
		expect(git(f.local, "rev-parse", "HEAD")).toBe(f.input.baselineSha);
		expect(readFileSync(join(f.local, "ignored.txt"), "utf8")).toBe("private\n");
	});

	it("does not overwrite ignored data while replaying intermediate local history", () => {
		const f = fixture();
		writeFileSync(join(f.local, "ignored.txt"), "temporary tracked version\n");
		git(f.local, "add", "--force", "ignored.txt");
		git(f.local, "commit", "-m", "Temporarily track file");
		git(f.local, "rm", "ignored.txt");
		git(f.local, "commit", "-m", "Stop tracking file");
		writeFileSync(join(f.local, "ignored.txt"), "retained local generated data\n");
		const head = git(f.local, "rev-parse", "HEAD");
		f.commit(f.dev, "remote.txt", "remote\n");
		f.push();
		expect(() => reconcileRepository(f.input)).toThrow(/ignored files/);
		expect(git(f.local, "rev-parse", "HEAD")).toBe(head);
		expect(readFileSync(join(f.local, "ignored.txt"), "utf8")).toBe(
			"retained local generated data\n",
		);
	});

	it("does not publish previously ignored files when remote ignore rules change", () => {
		const f = fixture();
		writeFileSync(join(f.local, "ignored.txt"), "local generated data\n");
		f.commit(f.dev, ".gitignore", "");
		f.push();
		expect(() => reconcileRepository(f.input)).toThrow(/Previously ignored local files/);
		expect(readFileSync(join(f.local, "ignored.txt"), "utf8")).toBe("local generated data\n");
		expect(() => reconcileRepository(f.input)).toThrow(/Previously ignored local files/);
	});

	it("preserves leading whitespace in ignored path collision checks", () => {
		const f = fixture();
		f.commit(f.dev, ".gitignore", " leading.txt\n");
		f.push();
		git(f.local, "pull", "--ff-only");
		writeFileSync(join(f.local, " leading.txt"), "retained\n");
		writeFileSync(join(f.dev, " leading.txt"), "remote\n");
		git(f.dev, "add", "--force", " leading.txt");
		git(f.dev, "commit", "-m", "Track path");
		f.push();
		expect(() =>
			reconcileRepository({ ...f.input, baselineSha: git(f.local, "rev-parse", "HEAD") }),
		).toThrow(/ignored files/);
		expect(readFileSync(join(f.local, " leading.txt"), "utf8")).toBe("retained\n");
	});

	it("blocks target rebases that would overwrite ignored local files", () => {
		const f = fixture();
		writeFileSync(join(f.local, "ignored.txt"), "retained\n");
		git(f.dev, "checkout", "-b", "target");
		writeFileSync(join(f.dev, "ignored.txt"), "target\n");
		git(f.dev, "add", "--force", "ignored.txt");
		git(f.dev, "commit", "-m", "Track target file");
		git(f.dev, "push", "origin", "target");
		expect(() =>
			startRebase(
				targetRepair(
					f,
					f.input.baselineSha,
					git(f.dev, "rev-parse", "HEAD"),
					"https://forge.example/pull/1",
				),
			),
		).toThrow(/Target changes collide with ignored files/);
		expect(git(f.local, "rev-parse", "HEAD")).toBe(f.input.baselineSha);
		expect(readFileSync(join(f.local, "ignored.txt"), "utf8")).toBe("retained\n");
	});

	it("does not duplicate patches already incorporated by a developer", () => {
		const f = fixture();
		f.commit(f.local, "same.txt", "same\n");
		f.commit(f.dev, "same.txt", "same\n");
		f.push();
		expect(reconcileRepository(f.input).status).toBe("ready");
		expect(readFileSync(join(f.local, "same.txt"), "utf8")).toBe("same\n");
	});

	it("recovers publication before its durable acknowledgement without another commit", () => {
		const f = fixture();
		const local = f.commit(f.local, "published.txt", "published\n");
		git(f.local, "push", "origin", "work");
		expect(reconcileRepository(f.input)).toMatchObject({ headSha: local, changed: false });
	});

	it("does not replay an accepted publication after a developer rewrite and lost server acknowledgement", () => {
		const f = fixture();
		writeFileSync(join(f.local, "published.txt"), "already delivered\n");
		const published = commitAndPushWorkBranch({
			repoPath: f.local,
			workBranch: "work",
			expectedRemoteHead: f.input.baselineSha,
			commitMessage: "Published change",
			gitIdentity: { name: "Bot", email: "bot@example.test" },
		});
		// No server/journal acknowledgement: the next remote revision deliberately removes this work.
		f.commit(f.dev, "replacement.txt", "developer rewrite\n");
		git(f.dev, "push", "--force", "origin", "work");
		const result = reconcileRepository(f.input);
		expect(result.headSha).toBe(git(f.dev, "rev-parse", "HEAD"));
		expect(existsSync(join(f.local, "published.txt"))).toBe(false);
		expect(git(f.local, "show", `${published.headSha}:published.txt`)).toBe("already delivered");
	});

	it.each([
		"unchanged",
		"rewritten",
	])("blocks an uncertain publication with an unproven %s remote", (remoteState) => {
		const f = fixture();
		const candidate = f.commit(f.local, "local.txt", "retained\n");
		attemptPublication(f, candidate);
		if (remoteState === "rewritten") {
			f.commit(f.dev, "remote.txt", "remote\n");
			f.push();
		}
		expect(() => reconcileRepository(f.input)).toThrow(/publication outcome is uncertain/);
		expect(git(f.local, "rev-parse", "HEAD")).toBe(candidate);
		expect(readFileSync(join(f.local, "local.txt"), "utf8")).toBe("retained\n");
	});

	it("proves uncertain acceptance from remote ancestry before adopting a subsequent developer push", () => {
		const f = fixture();
		const candidate = f.commit(f.local, "local.txt", "published\n");
		attemptPublication(f, candidate);
		git(f.local, "push", "origin", "work");
		git(f.dev, "pull", "--ff-only", "origin", "work");
		const remote = f.commit(f.dev, "developer.txt", "developer\n");
		f.push();
		expect(reconcileRepository(f.input).headSha).toBe(remote);
		expect(readPublicationReceipt(join(f.local, ".git"))).toMatchObject({
			status: "accepted",
			candidate,
		});
	});

	it("rejects a changed remote before publishing while preserving the local commit", () => {
		const f = fixture();
		writeFileSync(join(f.local, "local.txt"), "local\n");
		f.commit(f.dev, "remote.txt", "remote\n");
		f.push();
		expect(() =>
			commitAndPushWorkBranch({
				repoPath: f.local,
				workBranch: "work",
				expectedRemoteHead: f.input.baselineSha,
				commitMessage: "local change",
				gitIdentity: { name: "Bot", email: "bot@example.test" },
			}),
		).toThrow(/remote source branch changed/);
		expect(git(f.local, "show", "HEAD:local.txt")).toBe("local");
		expect(git(f.bare, "show", "work:remote.txt")).toBe("remote");
	});

	it("captures a baseline before implementation and reconciles a newly created remote branch", () => {
		const f = fixture();
		git(f.dev, "push", "origin", ":work");
		const { baselineSha: _baseline, ...initial } = f.input;
		expect(prepareInitialRepository(initial).remoteHead).toBeNull();
		writeFileSync(join(f.local, "local.txt"), "implementation\n");
		f.commit(f.dev, "remote.txt", "developer branch\n");
		f.push();
		expect(reconcilePublicationRepository(initial).status).toBe("ready");
		expect(readFileSync(join(f.local, "local.txt"), "utf8")).toBe("implementation\n");
		expect(readFileSync(join(f.local, "remote.txt"), "utf8")).toBe("developer branch\n");
	});

	it("recovers an interrupted index restoration idempotently", () => {
		const f = fixture();
		writeFileSync(join(f.local, "file.txt"), "staged\n");
		git(f.local, "add", "file.txt");
		writeFileSync(join(f.local, "untracked.txt"), "untracked\n");
		f.commit(f.dev, "remote.txt", "remote\n");
		f.push();
		const result = reconcileRepository(f.input);
		const refs = git(
			f.local,
			"for-each-ref",
			"--format=%(refname)",
			"refs/leitwerk/reconciled",
		).split("\n");
		const ref = refs[0];
		const id = ref.split("/").at(-1);
		const work = git(f.local, "rev-parse", ref);
		const index = git(f.local, "rev-parse", `${ref}~1^{tree}`);
		const file = join(f.local, ".git/leitwerk-reconciliation.json");
		const record = JSON.parse(readFileSync(file, "utf8"));
		record.operation = {
			id,
			work,
			remote: result.remoteHead,
			phase: "restoring",
			resultHead: result.headSha,
			resultIndex: index,
		};
		writeFileSync(file, JSON.stringify(record));
		git(f.local, "update-ref", "refs/heads/work", work);
		expect(reconcileRepository(f.input).headSha).toBe(result.headSha);
		expect(git(f.local, "show", ":file.txt")).toBe("staged");
		expect(git(f.local, "status", "--porcelain")).toContain("?? untracked.txt");
		expect(reconcileRepository(f.input).changed).toBe(false);
	});

	it("preserves new staged work when a captured checkpoint is no longer current", () => {
		const f = fixture();
		writeFileSync(join(f.local, "file.txt"), "checkpoint staged\n");
		git(f.local, "add", "file.txt");
		f.commit(f.dev, "remote.txt", "remote\n");
		f.push();
		reconcileRepository(f.input);
		const checkpoint = git(
			f.local,
			"for-each-ref",
			"--format=%(refname)",
			"refs/leitwerk/checkpoints",
		);
		const work = git(f.local, "rev-parse", checkpoint);
		const index = git(f.local, "rev-parse", `${checkpoint}~1`);
		git(f.local, "reset", "--hard", f.input.baselineSha);
		writeFileSync(join(f.local, "file.txt"), "new staged content\n");
		git(f.local, "add", "file.txt");
		writeFileSync(join(f.local, "file.txt"), "new unstaged content\n");
		const file = join(f.local, ".git/leitwerk-reconciliation.json");
		const record = JSON.parse(readFileSync(file, "utf8"));
		record.baseline = f.input.baselineSha;
		record.operation = {
			id: checkpoint.split("/").at(-1),
			head: f.input.baselineSha,
			index,
			work,
			remote: record.baseline,
			phase: "captured",
		};
		writeFileSync(file, JSON.stringify(record));
		expect(() => reconcileRepository(f.input)).toThrow(/changed after its checkpoint/);
		expect(git(f.local, "show", ":file.txt")).toBe("new staged content");
		expect(readFileSync(join(f.local, "file.txt"), "utf8")).toBe("new unstaged content\n");
	});

	it("rejects a push racing after the lease precheck", () => {
		const f = fixture();
		writeFileSync(join(f.local, "local.txt"), "agent\n");
		const concurrent = f.commit(f.dev, "remote.txt", "developer\n");
		git(f.bare, "fetch", f.dev, "HEAD");
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		const receivePack = join(f.root, "receive-pack");
		writeFileSync(
			receivePack,
			`#!/bin/sh\nset -e\n${quote(resolveGitBinary())} --git-dir=${quote(f.bare)} update-ref refs/heads/work ${concurrent}\nexec ${quote(resolveGitBinary())} receive-pack "$@"\n`,
			{ mode: 0o700 },
		);
		git(f.local, "config", "remote.origin.receivepack", quote(receivePack));
		expect(() =>
			commitAndPushWorkBranch({
				repoPath: f.local,
				workBranch: "work",
				expectedRemoteHead: f.input.baselineSha,
				commitMessage: "Agent change",
				gitIdentity: { name: "Bot", email: "bot@example.test" },
			}),
		).toThrow(/remote source branch changed/);
		expect(git(f.bare, "show", "work:remote.txt")).toBe("developer");
		expect(git(f.local, "show", "HEAD:local.txt")).toBe("agent");
	});

	it("refuses a changed repository binding or an unprovable baseline", () => {
		const f = fixture();
		reconcileRepository(f.input);
		git(f.local, "remote", "set-url", "--push", "origin", join(f.root, "elsewhere.git"));
		expect(() => reconcileRepository(f.input)).toThrow(/binding changed/);
		git(f.local, "config", "--unset", "remote.origin.pushurl");
		git(f.local, "checkout", "--orphan", "unrelated");
		f.commit(f.local, "unrelated.txt", "unrelated\n");
		git(f.local, "branch", "-M", "work");
		expect(() => reconcileRepository(f.input)).toThrow(/unpublished work.*baseline/);
	});

	it("reconciles a developer push during target rebase without resurrecting deleted shared changes", () => {
		const f = fixture();
		f.commit(f.dev, "published.txt", "previously published\n");
		const source = f.commit(f.dev, "file.txt", "feature\n");
		f.push();
		git(f.local, "pull", "--ff-only");
		recordRepositoryPublication(f.input, source);
		git(f.dev, "checkout", "-b", "target", f.input.baselineSha);
		f.commit(f.dev, "target.txt", "target change\n");
		const target = f.commit(f.dev, "file.txt", "target\n");
		git(f.dev, "push", "origin", "target");
		const repair = targetRepair(f, source, target, "https://forge.example/team/repo/pull/1");
		startRebase(repair);
		writeFileSync(join(f.local, "file.txt"), "target and feature resolved\n");
		git(f.local, "add", "file.txt");
		git(f.local, "rebase", "--continue");
		const rebased = verifyRebase(repair);
		git(f.dev, "checkout", "work");
		git(f.dev, "rm", "published.txt");
		const developer = f.commit(f.dev, "developer.txt", "developer change\n");
		f.push();
		expect(() => publishRebase(repair)).toThrow(ConcurrentRebaseSourceError);
		retainConcurrentRebase({
			...f.input,
			baselineSha: source,
			rebasedHead: rebased.headSha,
			targetBase: target,
			gitIdentity: { name: "Integration Bot", email: "integration@example.test" },
		});
		const reconciled = reconcileRepository(f.input);
		expect(reconciled.status).toBe("ready");
		expect(existsSync(join(f.local, "published.txt"))).toBe(false);
		expect(readFileSync(join(f.local, "file.txt"), "utf8")).toBe("target and feature resolved\n");
		expect(readFileSync(join(f.local, "developer.txt"), "utf8")).toBe("developer change\n");
		expect(readFileSync(join(f.local, "target.txt"), "utf8")).toBe("target change\n");
		expect(git(f.local, "merge-base", "--is-ancestor", developer, "HEAD")).toBe("");
		expect(git(f.local, "merge-base", "--is-ancestor", target, "HEAD")).toBe("");
		for (const revision of ["HEAD", "HEAD^"])
			expect(git(f.local, "log", "-1", "--format=%an%n%ae%n%cn%n%ce", revision)).toBe(
				"Integration Bot\nintegration@example.test\nIntegration Bot\nintegration@example.test",
			);
		commitAndPushWorkBranch({
			repoPath: f.local,
			workBranch: "work",
			expectedRemoteHead: developer,
			commitMessage: "Repair",
			gitIdentity: { name: "Bot", email: "bot@example.test" },
		});
		expect(git(f.bare, "rev-parse", "work")).toBe(reconciled.headSha);
		// An accepted repair can subsequently be removed deliberately. Never reapply it
		// merely because the server missed its acknowledgement.
		const rewritten = f.commit(f.dev, "after.txt", "after publication\n");
		git(f.dev, "push", "--force", "origin", "work");
		try {
			publishRebase(repair);
			throw new Error("Expected source change");
		} catch (error) {
			expect(error).toBeInstanceOf(ConcurrentRebaseSourceError);
			expect((error as ConcurrentRebaseSourceError).published).toBe(true);
		}
		expect(reconcileRepository(f.input).headSha).toBe(rewritten);
		expect(existsSync(join(f.local, "target.txt"))).toBe(false);
	});

	it("does not recreate a deleted branch and retains local edits", () => {
		const f = fixture();
		git(f.dev, "push", "origin", ":work");
		writeFileSync(join(f.local, "local.txt"), "retained\n");
		expect(() => reconcileRepository(f.input)).toThrow();
		expect(readFileSync(join(f.local, "local.txt"), "utf8")).toBe("retained\n");
	});
});
