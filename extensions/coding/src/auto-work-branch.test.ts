import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildAutoWorkBranch,
	resolveBaseBranchSha,
	slugifyBranchSourceForBranch,
} from "./auto-work-branch.js";

// Real git subprocesses make these cases slow under the full parallel suite;
// raise the timeout so process-spawn contention does not flake them.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
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
	});
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("local repo change automatic work branches", () => {
	it("slugifies the first source words for safe branch names", () => {
		expect(slugifyBranchSourceForBranch("Fix: login flow & OAuth redirects now please!")).toBe(
			"fix-login-flow-oauth-redirects",
		);
		expect(slugifyBranchSourceForBranch("  ---  ")).toBe("change");
	});

	it("uses the source slug, random hex, and short base branch sha", () => {
		expect(
			buildAutoWorkBranch("Fix login flow", "A1B2C3D4E5F60718293A4B5C6D7E8F9012345678", "abc"),
		).toBe("fix-login-flow-abc-a1b2c3d4e5f6");
	});

	it("resolves the configured base branch sha with git metadata", async () => {
		const repoDir = createTempDir("local-repo-change-auto-branch");
		git(repoDir, "init");
		git(repoDir, "config", "user.email", "test@example.com");
		git(repoDir, "config", "user.name", "Test User");
		writeFileSync(path.join(repoDir, "README.md"), "# Example\n", "utf8");
		git(repoDir, "add", "README.md");
		git(repoDir, "commit", "-m", "initial");
		git(repoDir, "branch", "-M", "main");
		const expectedSha = git(repoDir, "rev-parse", "main").trim();

		await expect(resolveBaseBranchSha({ repoLocator: repoDir, baseBranch: "main" })).resolves.toBe(
			expectedSha,
		);
	});
});
