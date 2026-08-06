import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetGitBinaryCache, resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import {
	WORKER_IPC_CONNECT_TOKEN_ENV,
	WORKER_IPC_RECONNECT_ENV,
	WORKER_SNAPSHOT_TOKEN_ENV,
} from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deserializeManifest } from "./manifest.js";
import { NodeRunRootGitOps } from "./node-run-root-git-ops.js";
import { materializeRunRoot, planRunRoot } from "./run-root.js";

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

	it("clones real repos into the workspace and writes aggregated artifacts", async () => {
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

		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(existsSync(path.join(workspaceRoot, "repo", ".git"))).toBe(true);
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
