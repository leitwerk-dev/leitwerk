import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { commitAndPushWorkBranch, repositoryHasChanges } from "./finalization-git.js";

import { createGitFixture, runGit } from "./git-fixture.test-fixture.js";

const copyWorkspace = createGitFixture(createTemplate);

function git(cwd: string, ...args: string[]): string {
	return runGit(cwd, args);
}

function createTemplate(templateRoot: string) {
	const remoteDir = path.join(templateRoot, "remote.git");
	git(templateRoot, "init", "--bare", remoteDir);
	const seedDir = path.join(templateRoot, "seed");
	git(templateRoot, "clone", remoteDir, seedDir);
	git(seedDir, "config", "user.name", "Test User");
	git(seedDir, "config", "user.email", "test@example.com");
	writeFileSync(path.join(seedDir, "README.md"), "# Example\n");
	git(seedDir, "add", ".");
	git(seedDir, "commit", "-m", "seed");
	git(seedDir, "branch", "-M", "main");
	git(seedDir, "push", "origin", "main");
	const repoDir = path.join(templateRoot, "workspace");
	git(templateRoot, "clone", remoteDir, repoDir);
	git(repoDir, "checkout", "-b", "feature/test", "origin/main");
	rmSync(seedDir, { recursive: true, force: true });
}

function createWorkspace() {
	const { root } = copyWorkspace();
	const remoteDir = path.join(root, "remote.git");
	const repoDir = path.join(root, "workspace");
	git(repoDir, "remote", "set-url", "origin", remoteDir);
	return { remoteDir, repoDir };
}

describe("commitAndPushWorkBranch", () => {
	it.each([
		"staged",
		"unstaged",
		"untracked",
		"committed",
	])("detects %s changes before publication", (kind) => {
		const { repoDir } = createWorkspace();
		expect(repositoryHasChanges(repoDir, "main")).toBe(false);
		writeFileSync(path.join(repoDir, kind === "untracked" ? "new.txt" : "README.md"), "Changed\n");
		if (kind === "staged" || kind === "committed") git(repoDir, "add", ".");
		if (kind === "committed")
			git(
				repoDir,
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-m",
				"change",
			);
		expect(repositoryHasChanges(repoDir, "main")).toBe(true);
	});
	it("commits dirty work and publishes only the checked-out feature branch", () => {
		const { remoteDir, repoDir } = createWorkspace();
		const mainSha = git(remoteDir, "rev-parse", "refs/heads/main");
		writeFileSync(path.join(repoDir, "feature.txt"), "remote change\n");

		const result = commitAndPushWorkBranch({
			repoPath: repoDir,
			workBranch: "feature/test",
			commitMessage: "feat: publish remote change",
			gitIdentity: { name: "Leitwerk Bot", email: "leitwerk-bot@noreply.example.test" },
		});

		expect(result.pushTarget).toBe("origin/feature/test");
		expect(git(remoteDir, "rev-parse", "refs/heads/main")).toBe(mainSha);
		expect(git(remoteDir, "rev-parse", "refs/heads/feature/test")).toBe(result.headSha);
		expect(git(remoteDir, "show", "refs/heads/feature/test:feature.txt")).toBe("remote change");
		expect(git(remoteDir, "log", "-1", "--format=%s", "refs/heads/feature/test")).toBe(
			"feat: publish remote change",
		);
		expect(
			git(remoteDir, "log", "-1", "--format=%an%n%ae%n%cn%n%ce", "refs/heads/feature/test"),
		).toBe(
			"Leitwerk Bot\nleitwerk-bot@noreply.example.test\nLeitwerk Bot\nleitwerk-bot@noreply.example.test",
		);
		expect(git(repoDir, "status", "--short")).toBe("");
	});

	it("rejects an unexpected checked-out branch", () => {
		const repoDir = mkdtempSync(path.join(tmpdir(), "coding-feature-mismatch-"));
		onTestFinished(() => rmSync(repoDir, { recursive: true, force: true }));
		git(repoDir, "init", "--initial-branch=feature/test");
		expect(() =>
			commitAndPushWorkBranch({
				repoPath: repoDir,
				workBranch: "feature/other",
				commitMessage: "feat: publish remote change",
				gitIdentity: { name: "Leitwerk Bot", email: "bot@example.test" },
			}),
		).toThrow(/feature\/other.*feature\/test/);
	});
});
