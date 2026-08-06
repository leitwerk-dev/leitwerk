import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createTestProcessInstance,
	createTestProcessProject,
} from "@leitwerk-dev/extension-runtime/testing";
import type { FlowAutomaticRunContext } from "@leitwerk-dev/process-sdk";
import { createEmptyStructuralProcessState } from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDeterministicFinalization } from "./finalization-git.js";
import type { RepositoryChangeParamsBase } from "./repository-change-launch.js";
import {
	type RepositoryChangeState as LocalRepoChangeState,
	resetRepositoryChangeFinalizationState as resetLocalRepoChangeFinalizationState,
} from "./repository-change-state.js";

// These tests spawn many real git subprocesses per case; raise the timeout so
// process-spawn contention under the full parallel suite does not flake them.
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
	}).trim();
}

function createBareRemote(): string {
	const remoteDir = createTempDir("local-repo-change-remote");
	git(remoteDir, "init", "--bare");
	return remoteDir;
}

function createNonBareRemote(files: Record<string, string>): string {
	const remoteDir = createTempDir("local-repo-change-non-bare-remote");
	git(remoteDir, "init");
	git(remoteDir, "config", "user.email", "test@example.com");
	git(remoteDir, "config", "user.name", "Test User");
	for (const [filePath, content] of Object.entries(files)) {
		const absolutePath = path.join(remoteDir, filePath);
		mkdirSync(path.dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, content, "utf8");
	}
	git(remoteDir, "add", ".");
	git(remoteDir, "commit", "-m", "seed main");
	git(remoteDir, "branch", "-M", "main");
	return remoteDir;
}

function cloneBareSourceRepo(upstreamDir: string): string {
	const sourceDir = createTempDir("local-repo-change-bare-source");
	git(sourceDir, "clone", "--bare", upstreamDir, ".");
	return sourceDir;
}

function cloneNonBareSourceRepo(upstreamDir: string): string {
	const sourceDir = createTempDir("local-repo-change-non-bare-source");
	git(sourceDir, "clone", upstreamDir, ".");
	git(sourceDir, "config", "user.email", "test@example.com");
	git(sourceDir, "config", "user.name", "Test User");
	git(sourceDir, "checkout", "-B", "main", "origin/main");
	return sourceDir;
}

function seedRemoteMain(remoteDir: string, files: Record<string, string>): void {
	const seedDir = createTempDir("local-repo-change-seed");
	git(seedDir, "clone", remoteDir, ".");
	git(seedDir, "config", "user.email", "test@example.com");
	git(seedDir, "config", "user.name", "Test User");
	for (const [filePath, content] of Object.entries(files)) {
		const absolutePath = path.join(seedDir, filePath);
		mkdirSync(path.dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, content, "utf8");
	}
	git(seedDir, "add", ".");
	git(seedDir, "commit", "-m", "seed main");
	git(seedDir, "branch", "-M", "main");
	git(seedDir, "push", "origin", "main");
}

function cloneWorkspaceRepo(remoteDir: string): string {
	const workspaceRoot = createTempDir("local-repo-change-workspace");
	const repoDir = path.join(workspaceRoot, "repo");
	git(workspaceRoot, "clone", remoteDir, "repo");
	git(repoDir, "config", "user.email", "test@example.com");
	git(repoDir, "config", "user.name", "Test User");
	git(repoDir, "checkout", "-b", "feature/test", "origin/main");
	return repoDir;
}

function createSeededWorkspace(): { remoteDir: string; repoDir: string } {
	const remoteDir = createBareRemote();
	seedRemoteMain(remoteDir, { "README.md": "# Example\n" });
	return { remoteDir, repoDir: cloneWorkspaceRepo(remoteDir) };
}

function commitFile(
	repoDir: string,
	filePath: string,
	content: string,
	message = "feature work",
): string {
	const absolutePath = path.join(repoDir, filePath);
	mkdirSync(path.dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, content, "utf8");
	git(repoDir, "add", filePath);
	git(repoDir, "commit", "-m", message);
	return headSha(repoDir);
}

function advanceRemoteMain(remoteDir: string, updater: (repoDir: string) => void): string {
	const updateDir = createTempDir("local-repo-change-update");
	git(updateDir, "clone", remoteDir, ".");
	git(updateDir, "config", "user.email", "test@example.com");
	git(updateDir, "config", "user.name", "Test User");
	git(updateDir, "checkout", "main");
	updater(updateDir);
	git(updateDir, "add", ".");
	git(updateDir, "commit", "-m", "advance main");
	git(updateDir, "push", "origin", "main");
	return git(updateDir, "rev-parse", "HEAD");
}

function advanceNonBareRemoteMain(remoteDir: string, updater: (repoDir: string) => void): string {
	git(remoteDir, "checkout", "main");
	updater(remoteDir);
	git(remoteDir, "add", ".");
	git(remoteDir, "commit", "-m", "advance main");
	return git(remoteDir, "rev-parse", "HEAD");
}

function headSha(repoDir: string, ref = "HEAD"): string {
	return git(repoDir, "rev-parse", ref);
}

function createFinalizationContext(input: {
	repoPath: string;
	workspaceClonePath?: string;
	baseBranch?: string;
	workBranch?: string;
	expectedPostConflictHeadSha?: string | null;
	usedConflictResolution?: boolean;
	commitMessage?: string;
}): FlowAutomaticRunContext<RepositoryChangeParamsBase, LocalRepoChangeState> {
	const baseBranch = input.baseBranch ?? "main";
	const workBranch = input.workBranch ?? "feature/test";
	const workspaceClonePath = input.workspaceClonePath ?? "./repo";
	const key = workspaceClonePath.replace(/^\.\//, "") || "repo";
	return {
		process: createTestProcessInstance({ processId: "local_repo_change_process" }),
		projects: [
			createTestProcessProject({
				key,
				repoLocator: input.repoPath,
				repoLocatorKind: "local_path",
				baseBranch,
				workBranch,
			}),
		],
		params: {
			launchKind: "requested_change",
			repoLocator: input.repoPath,
			baseBranch,
			workBranch,
			prompt: "Test change",
		},
		state: {
			...createEmptyStructuralProcessState(),
			finalization: resetLocalRepoChangeFinalizationState({
				expectedPostConflictHeadSha: input.expectedPostConflictHeadSha ?? null,
				usedConflictResolution: input.usedConflictResolution === true,
				generatedCommitMessage: input.commitMessage ?? "Summarize the accepted plan",
			}),
		},
		repo: {
			get: (requestedKey) => {
				if (requestedKey !== key) {
					throw new Error(`Unknown test repo ${requestedKey}`);
				}
				return {
					key,
					fsPath: input.repoPath,
					workspaceClonePath,
					baseBranch,
					workBranch,
					locator: input.repoPath,
				};
			},
			optional: (requestedKey) =>
				requestedKey === key
					? {
							key,
							fsPath: input.repoPath,
							workspaceClonePath,
							baseBranch,
							workBranch,
							locator: input.repoPath,
						}
					: undefined,
			all: () => [
				{
					key,
					fsPath: input.repoPath,
					workspaceClonePath,
					baseBranch,
					workBranch,
					locator: input.repoPath,
				},
			],
		},
	};
}

function runFinalization(input: Parameters<typeof createFinalizationContext>[0]) {
	return runDeterministicFinalization(createFinalizationContext(input));
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("runDeterministicFinalization", () => {
	it("commits a dirty worktree deterministically before finalizing", () => {
		const { remoteDir, repoDir } = createSeededWorkspace();
		const baselineSha = headSha(repoDir);
		writeFileSync(path.join(repoDir, "README.md"), "# Example\n\nChanged\n", "utf8");
		writeFileSync(path.join(repoDir, "feature.txt"), "feature work\n", "utf8");

		const result = runFinalization({
			repoPath: repoDir,
			commitMessage:
				"Summarize the accepted plan\n\nExplain the durable change safely; $(not-a-shell).",
		});

		expect(result).toMatchObject({ outcome: "finalized" });
		expect(git(repoDir, "status", "--short")).toBe("");
		expect(git(repoDir, "show", "-s", "--format=%B", "HEAD")).toBe(
			"Summarize the accepted plan\n\nExplain the durable change safely; $(not-a-shell).",
		);
		expect(git(repoDir, "show", "-s", "--format=%an <%ae>", "HEAD")).toBe(
			"Test User <test@example.com>",
		);
		expect(git(repoDir, "rev-parse", "HEAD^")).toBe(baselineSha);
		expect(headSha(remoteDir, "refs/heads/main")).toBe(headSha(repoDir));
	});

	it("fails identity preflight before staging files", () => {
		const { repoDir } = createSeededWorkspace();
		git(repoDir, "config", "--unset", "user.name");
		git(repoDir, "config", "--unset", "user.email");
		git(repoDir, "config", "user.useConfigOnly", "true");
		writeFileSync(path.join(repoDir, "feature.txt"), "feature work\n", "utf8");

		expect(() => runFinalization({ repoPath: repoDir })).toThrow(/identity is not configured/i);
		expect(git(repoDir, "diff", "--cached", "--name-only")).toBe("");
		expect(git(repoDir, "status", "--short")).toBe("?? feature.txt");
	});

	it("preflights a dirty local source before mutating the workspace branch", () => {
		const sourceDir = createNonBareRemote({ "README.md": "# Example\n" });
		const repoDir = cloneWorkspaceRepo(sourceDir);
		writeFileSync(path.join(repoDir, "feature.txt"), "feature work\n", "utf8");
		advanceNonBareRemoteMain(sourceDir, (baseDir) => {
			writeFileSync(path.join(baseDir, "base.txt"), "base work\n", "utf8");
		});
		writeFileSync(path.join(sourceDir, "PRODUCT.md"), "local operator work\n", "utf8");
		const workspaceHeadBefore = headSha(repoDir);

		expect(() => runFinalization({ repoPath: repoDir })).toThrow(/must be clean/);
		expect(headSha(repoDir)).toBe(workspaceHeadBefore);
		expect(git(repoDir, "status", "--short")).toBe("?? feature.txt");
	});

	it("resumes when an earlier attempt already merged the base into the workspace", () => {
		const { remoteDir, repoDir } = createSeededWorkspace();
		commitFile(repoDir, "feature.txt", "feature work\n");
		advanceRemoteMain(remoteDir, (baseDir) => {
			writeFileSync(path.join(baseDir, "base.txt"), "base work\n", "utf8");
		});
		git(repoDir, "fetch", "origin", "main");
		git(repoDir, "merge", "--no-edit", "origin/main");
		const mergedHead = headSha(repoDir);

		const result = runFinalization({ repoPath: repoDir });

		expect(result).toMatchObject({ outcome: "finalized", params: { mergeMode: "noop" } });
		expect(headSha(repoDir)).toBe(mergedHead);
		expect(headSha(remoteDir, "refs/heads/main")).toBe(mergedHead);
	});

	it("ignores the documented post-conflict HEAD sha once the merge is resolved cleanly", () => {
		const remoteDir = createBareRemote();
		seedRemoteMain(remoteDir, { "README.md": "line one\nline two\n" });
		const repoDir = cloneWorkspaceRepo(remoteDir);
		writeFileSync(path.join(repoDir, "README.md"), "line one\nfeature change\n", "utf8");
		git(repoDir, "add", "README.md");
		git(repoDir, "commit", "-m", "feature change");
		advanceRemoteMain(remoteDir, (updateDir) => {
			writeFileSync(path.join(updateDir, "README.md"), "line one\nbase change\n", "utf8");
		});
		git(repoDir, "fetch", "origin", "main");
		expect(() => git(repoDir, "merge", "--no-edit", "origin/main")).toThrow();
		writeFileSync(
			path.join(repoDir, "README.md"),
			"line one\nfeature change\nbase change\n",
			"utf8",
		);
		git(repoDir, "add", "README.md");
		git(repoDir, "commit", "--no-edit");

		const result = runFinalization({
			repoPath: repoDir,
			workspaceClonePath: "./repo",
			baseBranch: "main",
			workBranch: "feature/test",
			expectedPostConflictHeadSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
			usedConflictResolution: true,
		});

		expect(result).toMatchObject({
			outcome: "finalized",
			params: {
				mergeMode: "noop",
				pushTarget: "origin/main",
				usedConflictResolution: true,
			},
		});
		if (result.outcome !== "finalized") {
			throw new Error("expected finalized outcome");
		}
		expect(headSha(repoDir)).toBe(result.params.headSha);
		expect(headSha(remoteDir, "refs/heads/main")).toBe(result.params.headSha);
	});

	it("finalizes a clean repo by pushing HEAD to origin/main", () => {
		const remoteDir = createBareRemote();
		seedRemoteMain(remoteDir, { "README.md": "# Example\n" });
		const repoDir = cloneWorkspaceRepo(remoteDir);

		const result = runFinalization({
			repoPath: repoDir,
			workspaceClonePath: "./repo",
			baseBranch: "main",
			workBranch: "feature/test",
		});

		expect(result).toMatchObject({
			outcome: "finalized",
			params: {
				mergeMode: "noop",
				pushTarget: "origin/main",
				usedConflictResolution: false,
			},
		});
		if (result.outcome !== "finalized") {
			throw new Error("expected finalized outcome");
		}
		expect(headSha(repoDir)).toBe(result.params.headSha);
		expect(headSha(repoDir, "main")).toBe(result.params.headSha);
		expect(headSha(remoteDir, "refs/heads/main")).toBe(result.params.headSha);
		expect(result.markdown).toContain("HEAD -> origin/main");
	});

	it("merges origin/main into the work branch and pushes HEAD to origin/main for bare origins", () => {
		const remoteDir = createBareRemote();
		seedRemoteMain(remoteDir, { "README.md": "# Example\n" });
		const repoDir = cloneWorkspaceRepo(remoteDir);
		writeFileSync(path.join(repoDir, "feature.txt"), "feature work\n", "utf8");
		git(repoDir, "add", "feature.txt");
		git(repoDir, "commit", "-m", "feature work");
		advanceRemoteMain(remoteDir, (updateDir) => {
			writeFileSync(path.join(updateDir, "base.txt"), "base work\n", "utf8");
		});

		const result = runFinalization({
			repoPath: repoDir,
			workspaceClonePath: "./repo",
			baseBranch: "main",
			workBranch: "feature/test",
		});

		expect(result).toMatchObject({
			outcome: "finalized",
			params: {
				pushTarget: "origin/main",
				usedConflictResolution: false,
			},
		});
		if (result.outcome !== "finalized") {
			throw new Error("expected finalized outcome");
		}
		expect(result.params.mergeMode).toBe("merge_commit");
		expect(headSha(repoDir)).toBe(result.params.headSha);
		expect(headSha(repoDir, "main")).toBe(result.params.headSha);
		expect(headSha(remoteDir, "refs/heads/main")).toBe(result.params.headSha);
		expect(result.markdown).toContain("HEAD -> origin/main");
	});

	it("pushes a local bare source repo base branch to its own origin", () => {
		const upstreamDir = createBareRemote();
		seedRemoteMain(upstreamDir, { "README.md": "# Example\n" });
		const sourceDir = cloneBareSourceRepo(upstreamDir);
		const repoDir = cloneWorkspaceRepo(sourceDir);
		writeFileSync(path.join(repoDir, "feature.txt"), "feature work\n", "utf8");
		git(repoDir, "add", "feature.txt");
		git(repoDir, "commit", "-m", "feature work");
		advanceRemoteMain(sourceDir, (updateDir) => {
			writeFileSync(path.join(updateDir, "base.txt"), "base work\n", "utf8");
		});

		const result = runFinalization({
			repoPath: repoDir,
			workspaceClonePath: "./repo",
			baseBranch: "main",
			workBranch: "feature/test",
		});

		expect(result).toMatchObject({
			outcome: "finalized",
			params: {
				pushTarget: "origin/main",
				usedConflictResolution: false,
			},
		});
		if (result.outcome !== "finalized") {
			throw new Error("expected finalized outcome");
		}
		expect(result.params.mergeMode).toBe("merge_commit");
		expect(headSha(repoDir)).toBe(result.params.headSha);
		expect(headSha(sourceDir, "refs/heads/main")).toBe(result.params.headSha);
		expect(headSha(upstreamDir, "refs/heads/main")).toBe(result.params.headSha);
		expect(result.markdown).toContain("Workspace publish: HEAD -> origin/main");
		expect(result.markdown).toContain("Source origin push: refs/heads/main -> origin/main");
	});

	it("publishes the work branch and fast-forwards a non-bare local source repo without upstream origin", () => {
		const remoteDir = createNonBareRemote({ "README.md": "# Example\n" });
		const repoDir = cloneWorkspaceRepo(remoteDir);
		writeFileSync(path.join(repoDir, "feature.txt"), "feature work\n", "utf8");
		git(repoDir, "add", "feature.txt");
		git(repoDir, "commit", "-m", "feature work");
		advanceNonBareRemoteMain(remoteDir, (baseDir) => {
			writeFileSync(path.join(baseDir, "base.txt"), "base work\n", "utf8");
		});

		const result = runFinalization({
			repoPath: repoDir,
			workspaceClonePath: "./repo",
			baseBranch: "main",
			workBranch: "feature/test",
		});

		expect(result).toMatchObject({
			outcome: "finalized",
			params: {
				pushTarget: "origin/main",
				usedConflictResolution: false,
			},
		});
		if (result.outcome !== "finalized") {
			throw new Error("expected finalized outcome");
		}
		expect(result.params.mergeMode).toBe("merge_commit");
		expect(headSha(repoDir)).toBe(result.params.headSha);
		expect(headSha(repoDir, "main")).toBe(result.params.headSha);
		expect(headSha(remoteDir)).toBe(result.params.headSha);
		expect(headSha(remoteDir, "main")).toBe(result.params.headSha);
		expect(headSha(remoteDir, "feature/test")).toBe(result.params.headSha);
		expect(git(remoteDir, "branch", "--show-current")).toBe("main");
		expect(result.markdown).toContain("Workspace publish: HEAD -> origin/feature/test");
		expect(result.markdown).toContain("Base repo merge: feature/test -> main");
		expect(result.markdown).toContain(
			"Source origin push: skipped (local source repo has no origin remote)",
		);
	});

	it("pushes a local non-bare source repo base branch to its own origin", () => {
		const upstreamDir = createBareRemote();
		seedRemoteMain(upstreamDir, { "README.md": "# Example\n" });
		const sourceDir = cloneNonBareSourceRepo(upstreamDir);
		const repoDir = cloneWorkspaceRepo(sourceDir);
		writeFileSync(path.join(repoDir, "feature.txt"), "feature work\n", "utf8");
		git(repoDir, "add", "feature.txt");
		git(repoDir, "commit", "-m", "feature work");
		advanceNonBareRemoteMain(sourceDir, (baseDir) => {
			writeFileSync(path.join(baseDir, "base.txt"), "base work\n", "utf8");
		});

		const result = runFinalization({
			repoPath: repoDir,
			workspaceClonePath: "./repo",
			baseBranch: "main",
			workBranch: "feature/test",
		});

		expect(result).toMatchObject({
			outcome: "finalized",
			params: {
				pushTarget: "origin/main",
				usedConflictResolution: false,
			},
		});
		if (result.outcome !== "finalized") {
			throw new Error("expected finalized outcome");
		}
		expect(result.params.mergeMode).toBe("merge_commit");
		expect(headSha(repoDir)).toBe(result.params.headSha);
		expect(headSha(sourceDir, "main")).toBe(result.params.headSha);
		expect(headSha(sourceDir, "feature/test")).toBe(result.params.headSha);
		expect(headSha(upstreamDir, "refs/heads/main")).toBe(result.params.headSha);
		expect(git(sourceDir, "branch", "--show-current")).toBe("main");
		expect(result.markdown).toContain("Workspace publish: HEAD -> origin/feature/test");
		expect(result.markdown).toContain("Base repo merge: feature/test -> main");
		expect(result.markdown).toContain("Source origin push: refs/heads/main -> origin/main");
	});

	it("fails when a local source repo origin push fails", () => {
		const upstreamDir = createBareRemote();
		seedRemoteMain(upstreamDir, { "README.md": "# Example\n" });
		const sourceDir = cloneBareSourceRepo(upstreamDir);
		const missingRemotePath = path.join(
			createTempDir("local-repo-change-missing-origin"),
			"missing.git",
		);
		git(sourceDir, "remote", "set-url", "origin", missingRemotePath);
		const repoDir = cloneWorkspaceRepo(sourceDir);
		writeFileSync(path.join(repoDir, "feature.txt"), "feature work\n", "utf8");
		git(repoDir, "add", "feature.txt");
		git(repoDir, "commit", "-m", "feature work");

		expect(() =>
			runFinalization({
				repoPath: repoDir,
				workspaceClonePath: "./repo",
				baseBranch: "main",
				workBranch: "feature/test",
			}),
		).toThrow(/Failed to push local source repo .* base branch 'main' to 'origin\/main'/);
	});

	it("returns merge_conflict when deterministic merge hits conflicts", () => {
		const remoteDir = createBareRemote();
		seedRemoteMain(remoteDir, { "README.md": "line one\nline two\n" });
		const repoDir = cloneWorkspaceRepo(remoteDir);
		writeFileSync(path.join(repoDir, "README.md"), "line one\nfeature change\n", "utf8");
		git(repoDir, "add", "README.md");
		git(repoDir, "commit", "-m", "feature change");
		advanceRemoteMain(remoteDir, (updateDir) => {
			writeFileSync(path.join(updateDir, "README.md"), "line one\nbase change\n", "utf8");
		});

		const result = runFinalization({
			repoPath: repoDir,
			workspaceClonePath: "./repo",
			baseBranch: "main",
			workBranch: "feature/test",
		});

		expect(result).toMatchObject({
			outcome: "merge_conflict",
			params: {
				conflictedFiles: ["README.md"],
			},
		});
		expect(existsSync(path.join(repoDir, ".git", "MERGE_HEAD"))).toBe(true);
	});
});
