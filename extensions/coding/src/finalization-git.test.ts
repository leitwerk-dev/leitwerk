import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import { afterEach, describe, expect, it } from "vitest";
import { commitAndPushWorkBranch } from "./finalization-git.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = path.join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync(resolveGitBinary(), args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function createWorkspace() {
	const remoteDir = tempDir("coding-feature-remote");
	git(remoteDir, "init", "--bare");
	const seedDir = tempDir("coding-feature-seed");
	git(seedDir, "clone", remoteDir, ".");
	git(seedDir, "config", "user.name", "Test User");
	git(seedDir, "config", "user.email", "test@example.com");
	writeFileSync(path.join(seedDir, "README.md"), "# Example\n");
	git(seedDir, "add", ".");
	git(seedDir, "commit", "-m", "seed");
	git(seedDir, "branch", "-M", "main");
	git(seedDir, "push", "origin", "main");
	const repoDir = tempDir("coding-feature-workspace");
	git(repoDir, "clone", remoteDir, ".");
	git(repoDir, "checkout", "-b", "feature/test", "origin/main");
	return { remoteDir, repoDir };
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("commitAndPushWorkBranch", () => {
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
		expect(git(repoDir, "status", "--short")).toBe("");
	});

	it("rejects an unexpected checked-out branch", () => {
		const { repoDir } = createWorkspace();
		expect(() =>
			commitAndPushWorkBranch({
				repoPath: repoDir,
				workBranch: "feature/other",
				commitMessage: "feat: publish remote change",
				gitIdentity: { name: "Leitwerk Bot", email: "bot@example.test" },
			}),
		).toThrow("Expected");
	});
});
