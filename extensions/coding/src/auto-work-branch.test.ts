import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
	buildAutoWorkBranch,
	resolveBaseBranchSha,
	slugifyBranchSourceForBranch,
} from "./auto-work-branch-internal.js";

// Real git subprocesses make these cases slow under the full parallel suite;
// raise the timeout so process-spawn contention does not flake them.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

	it("resolves the base branch before launch without ambient project credentials", async () => {
		onTestFinished(() => {
			vi.unstubAllEnvs();
		});
		const root = mkdtempSync(path.join(tmpdir(), "local-repo-change-auto-branch-"));
		onTestFinished(() => rmSync(root, { recursive: true, force: true }));
		const git = new LocalGit(root);
		const { worktree: repoDir } = git.seed({ owner: "test", name: "repo" });
		const expectedSha = git.head(repoDir, "main");
		// An inherited malformed Git configuration would make ls-remote fail.
		vi.stubEnv("GIT_CONFIG_COUNT", "invalid");
		vi.stubEnv("GIT_ASKPASS", "/missing/credential-helper");
		vi.stubEnv("LEITWERK_INTERNAL_REPOSITORY_GIT_HTTPS_HELPER", "/missing/project-helper");

		await expect(resolveBaseBranchSha({ repoLocator: repoDir, baseBranch: "main" })).resolves.toBe(
			expectedSha,
		);
	});
});
