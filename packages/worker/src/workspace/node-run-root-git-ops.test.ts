import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	clearRepositoryGitSshWrappers,
	setRepositoryGitSshWrapper,
} from "@leitwerk-dev/process-sdk";
import { resetGitBinaryCache, resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import {
	WORKER_IPC_CONNECT_TOKEN_ENV,
	WORKER_IPC_RECONNECT_ENV,
	WORKER_SNAPSHOT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deserializeManifest } from "./manifest.js";
import { NodeRunRootGitOps } from "./node-run-root-git-ops.js";
import { materializeRunRoot, planRunRoot, prepareOnDemandRunRoot } from "./run-root.js";

// Real git subprocesses (clone, commit, push) make this case slow under the
// full parallel suite; raise the timeout so spawn contention does not flake it.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

function createSourceRepo(): string {
	const repoDir = createTempDir("node-run-root-git-ops-source");
	git(repoDir, "init");
	git(repoDir, "config", "user.email", "test@example.com");
	git(repoDir, "config", "user.name", "Test User");
	writeFileSync(path.join(repoDir, "AGENTS.md"), "# Repo guidance\n", "utf8");
	mkdirSync(path.join(repoDir, ".cursor", "skills", "alpha"), { recursive: true });
	writeFileSync(
		path.join(repoDir, ".cursor", "skills", "alpha", "SKILL.md"),
		"# Alpha skill\n",
		"utf8",
	);
	git(repoDir, "add", "AGENTS.md", ".cursor/skills/alpha/SKILL.md");
	git(repoDir, "commit", "-m", "initial");
	git(repoDir, "branch", "-M", "main");
	return repoDir;
}

afterEach(() => {
	clearRepositoryGitSshWrappers();
	resetGitBinaryCache();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("NodeRunRootGitOps", () => {
	it("does not leak worker credentials into git subprocess environments", async () => {
		const binDir = createTempDir("node-run-root-git-ops-bin");
		writeFileSync(
			path.join(binDir, "git"),
			`#!/usr/bin/env node\nconsole.log([process.env.${WORKER_IPC_CONNECT_TOKEN_ENV}, process.env.${WORKER_IPC_RECONNECT_ENV}, process.env.${WORKER_SNAPSHOT_TOKEN_ENV}].map(v => v === undefined ? "missing" : v).join(","));\n`,
			{ encoding: "utf8", mode: 0o755 },
		);
		const previousPath = process.env.PATH;
		const previousConnect = process.env[WORKER_IPC_CONNECT_TOKEN_ENV];
		const previousReconnect = process.env[WORKER_IPC_RECONNECT_ENV];
		const previousSnapshot = process.env[WORKER_SNAPSHOT_TOKEN_ENV];
		process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
		process.env[WORKER_IPC_CONNECT_TOKEN_ENV] = "connect-secret";
		process.env[WORKER_IPC_RECONNECT_ENV] = "1";
		process.env[WORKER_SNAPSHOT_TOKEN_ENV] = "snapshot-secret";
		resetGitBinaryCache();
		const repoDir = createTempDir("node-run-root-git-ops-env-repo");
		try {
			await expect(new NodeRunRootGitOps().getHeadSha(repoDir)).resolves.toBe(
				"missing,missing,missing",
			);
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousConnect === undefined) delete process.env[WORKER_IPC_CONNECT_TOKEN_ENV];
			else process.env[WORKER_IPC_CONNECT_TOKEN_ENV] = previousConnect;
			if (previousReconnect === undefined) delete process.env[WORKER_IPC_RECONNECT_ENV];
			else process.env[WORKER_IPC_RECONNECT_ENV] = previousReconnect;
			if (previousSnapshot === undefined) delete process.env[WORKER_SNAPSHOT_TOKEN_ENV];
			else process.env[WORKER_SNAPSHOT_TOKEN_ENV] = previousSnapshot;
			resetGitBinaryCache();
		}
	});

	it("scopes a repository SSH wrapper to its project and removes it on cleanup", async () => {
		const binDir = createTempDir("node-run-root-git-ops-ssh-bin");
		writeFileSync(
			path.join(binDir, "git"),
			'#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.TEST_GIT_ENV_MARKER, process.env.GIT_SSH ?? "missing");\n',
			{ encoding: "utf8", mode: 0o755 },
		);
		const marker = path.join(createTempDir("node-run-root-git-ops-marker"), "env");
		const previousPath = process.env.PATH;
		const previousMarker = process.env.TEST_GIT_ENV_MARKER;
		process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
		process.env.TEST_GIT_ENV_MARKER = marker;
		resetGitBinaryCache();
		const gitOps = new NodeRunRootGitOps();
		try {
			gitOps.configureRepositoryCredentials([
				{
					projectKey: "repo",
					kind: "git_ssh",
					credentialRef: "default",
					privateKey: "private-key",
					knownHosts: "git.example ssh-ed25519 AAAA",
				},
			]);
			await gitOps.clone("source", path.join(createTempDir("ssh-repo"), "repo"));
			const wrapper = readFileSync(marker, "utf8");
			expect(wrapper).not.toBe("missing");
			expect(existsSync(wrapper)).toBe(true);
			gitOps.cleanupRepositoryCredentials();
			await gitOps.clone("source", path.join(createTempDir("plain-repo"), "repo"));
			expect(readFileSync(marker, "utf8")).toBe("missing");
			expect(existsSync(wrapper)).toBe(false);
		} finally {
			gitOps.cleanupRepositoryCredentials();
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			if (previousMarker === undefined) delete process.env.TEST_GIT_ENV_MARKER;
			else process.env.TEST_GIT_ENV_MARKER = previousMarker;
			resetGitBinaryCache();
		}
	});

	it("clones real repos onto the assigned work branch and writes aggregated artifacts", async () => {
		const sourceRepo = createSourceRepo();
		const workspaceRoot = createTempDir("node-run-root-git-ops-workspace");
		const gitOps = new NodeRunRootGitOps();

		const result = await materializeRunRoot(
			planRunRoot(workspaceRoot, "ag_real_clone", [
				{
					key: "repo",
					repoLocator: sourceRepo,
					baseBranch: "main",
					workBranch: "feature/test",
				},
			]),
			gitOps,
		);

		expect(existsSync(path.join(workspaceRoot, "repo", ".git"))).toBe(true);
		expect(git(path.join(workspaceRoot, "repo"), "symbolic-ref", "--short", "HEAD").trim()).toBe(
			"feature/test",
		);
		expect(readFileSync(path.join(workspaceRoot, "AGENTS.md"), "utf8")).toContain("Repo guidance");
		expect(result.loadedSkills).toEqual(["alpha"]);

		const manifestRaw = readFileSync(
			path.join(workspaceRoot, ".leitwerk", "components.json"),
			"utf8",
		);
		const parsed = deserializeManifest(manifestRaw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) {
			return;
		}
		expect(parsed.manifest.components).toHaveLength(1);
		expect(parsed.manifest.components[0]?.key).toBe("repo");
	});
});

it("pins shared checkouts at captured commits, fetches later captured commits, and preserves dirty files", async () => {
	const source = createSourceRepo();
	const captured = git(source, "rev-parse", "HEAD").trim();
	const workspace = createTempDir("pinned-component-checkout");
	const ops = new NodeRunRootGitOps();
	const { createCheckoutTool } = await import("./checkout-tool.js");
	const tool = createCheckoutTool(
		workspace,
		"instance",
		[
			{
				key: "monitor",
				repoLocator: source,
				baseBranch: "main",
				workBranch: "main",
			} as import("@leitwerk-dev/domain").ProcessProject,
		],
		ops,
	);
	const initial = (await tool.execute({ projectKey: "monitor", revision: captured })) as {
		path: string;
		headSha: string;
	};
	expect(initial.headSha).toBe(captured);
	writeFileSync(path.join(source, "AGENTS.md"), "# Updated component instructions\n");
	git(source, "add", "AGENTS.md");
	git(source, "commit", "-m", "new source");
	const next = git(source, "rev-parse", "HEAD").trim();
	for (let index = 0; index < 4; index++)
		expect(
			((await tool.execute({ projectKey: "monitor", revision: captured })) as { headSha: string })
				.headSha,
		).toBe(captured);
	expect(
		((await tool.execute({ projectKey: "monitor", revision: next })) as { headSha: string })
			.headSha,
	).toBe(next);
	expect(readFileSync(path.join(workspace, "AGENTS.md"), "utf8")).toContain(
		"Updated component instructions",
	);
	git(initial.path, "checkout", "--detach", captured);
	await prepareOnDemandRunRoot(
		planRunRoot(workspace, "instance", [
			{ key: "monitor", repoLocator: source, baseBranch: "main", workBranch: "main" },
		]),
		ops,
	);
	expect(git(initial.path, "rev-parse", "HEAD").trim()).toBe(next);
	writeFileSync(path.join(initial.path, "local-work.txt"), "preserve this");
	await expect(tool.execute({ projectKey: "monitor", revision: captured })).rejects.toThrow(
		"local changes",
	);
	expect(readFileSync(path.join(initial.path, "local-work.txt"), "utf8")).toBe("preserve this");
	await expect(tool.execute({ projectKey: "monitor", revision: "main" })).rejects.toThrow(
		"full commit",
	);
});

function addSubmodule(repo: string, name: string, url: string, sha: string) {
	git(repo, "config", "-f", ".gitmodules", `submodule.${name}.path`, name);
	git(repo, "config", "-f", ".gitmodules", `submodule.${name}.url`, url);
	git(repo, "add", ".gitmodules");
	git(repo, "update-index", "--add", "--cacheinfo", `160000,${sha},${name}`);
	git(repo, "commit", "-m", `Add ${name} dependency`);
}

it("prepares nested submodules at the selected checkout and preserves retained edits", async () => {
	const source = createSourceRepo();
	const dependency = createSourceRepo();
	const nested = createSourceRepo();
	writeFileSync(path.join(nested, "nested.txt"), "nested");
	git(nested, "add", "nested.txt");
	git(nested, "commit", "-m", "Nested content");
	const nestedHead = git(nested, "rev-parse", "HEAD").trim();
	addSubmodule(dependency, "nested", "ssh://git@forge.test/nested.git", nestedHead);
	const dependencyHead = git(dependency, "rev-parse", "HEAD").trim();
	git(source, "switch", "-c", "target");
	addSubmodule(source, "dependency", "ssh://git@forge.test/dependency.git", dependencyHead);
	git(source, "switch", "main");

	const workspace = createTempDir("submodule-workspace");
	const wrapper = path.join(workspace, "ssh");
	writeFileSync(
		wrapper,
		`#!/bin/sh
for last; do :; done
case "$last" in
  "git-upload-pack '/nested.git'") exec git-upload-pack "${nested}";;
  "git-upload-pack '/dependency.git'") exec git-upload-pack "${dependency}";;
  *) exit 1;;
esac
`,
		{ mode: 0o700 },
	);
	setRepositoryGitSshWrapper("repo", wrapper);

	const ops = new NodeRunRootGitOps();
	const plan = planRunRoot(
		workspace,
		"instance",
		[{ key: "repo", repoLocator: source, baseBranch: "target", workBranch: "work" }],
		{},
	);
	const result = await materializeRunRoot(plan, ops);
	const checkout = path.join(workspace, "repo");
	const depPath = path.join(checkout, "dependency");
	expect(result.submoduleWarnings).toBeUndefined();
	expect(git(depPath, "rev-parse", "HEAD").trim()).toBe(dependencyHead);
	expect(git(path.join(depPath, "nested"), "rev-parse", "HEAD").trim()).toBe(nestedHead);
	expect(readFileSync(path.join(depPath, "nested", "nested.txt"), "utf8")).toBe("nested");
	expect(result.aggregatedAgentsMdSources).toEqual(["repo/AGENTS.md"]);
	expect(result.loadedSkills).toEqual(["alpha"]);

	git(
		depPath,
		"-c",
		"user.email=test@example.com",
		"-c",
		"user.name=Test User",
		"commit",
		"--allow-empty",
		"-m",
		"Unpublished submodule commit",
	);
	const localHead = git(depPath, "rev-parse", "HEAD").trim();
	writeFileSync(path.join(depPath, "local.txt"), "preserve this");
	const retained = await materializeRunRoot(plan, ops, true);
	expect(retained.submoduleWarnings).toEqual([expect.stringContaining("left untouched")]);
	expect(git(depPath, "rev-parse", "HEAD").trim()).toBe(localHead);
	expect(readFileSync(path.join(depPath, "local.txt"), "utf8")).toBe("preserve this");
	expect(readFileSync(path.join(workspace, "AGENTS.md"), "utf8")).toContain(
		"Workspace preparation warnings",
	);
});

it("returns a pinned checkout with a safe warning when a submodule transport is not allowed", async () => {
	const source = createSourceRepo();
	const dependency = createSourceRepo();
	const original = git(source, "rev-parse", "HEAD").trim();
	addSubmodule(source, "dependency", dependency, git(dependency, "rev-parse", "HEAD").trim());
	const revision = git(source, "rev-parse", "HEAD").trim();
	const workspace = createTempDir("submodule-unavailable");
	const plan = planRunRoot(
		workspace,
		"instance",
		[{ key: "repo", repoLocator: source, baseBranch: "main", workBranch: "main" }],
		{},
	);
	const ops = new NodeRunRootGitOps();
	const first = await prepareOnDemandRunRoot(plan, ops, "repo", original);
	expect(first.submoduleWarnings).toBeUndefined();
	const second = await prepareOnDemandRunRoot(plan, ops, "repo", revision);
	expect(second.manifest.components[0]?.headSha).toBe(revision);
	expect(second.submoduleWarnings).toEqual([
		expect.stringContaining("check repository access or transport"),
	]);
	expect(second.submoduleWarnings?.join()).not.toContain(dependency);
	expect(existsSync(path.join(workspace, "repo", "dependency", "AGENTS.md"))).toBe(false);
});
