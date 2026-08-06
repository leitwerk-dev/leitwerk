import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	clearRepositoryGitSshWrappers,
	repositoryGitArgs,
	repositoryGitSubprocessEnv,
	setRepositoryGitSshWrapper,
} from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import type { WorkerGitSshCredential } from "@leitwerk-dev/worker-protocol";
import { execa } from "execa";
import fg from "fast-glob";
import type { RunRootGitOps } from "./run-root.js";

function toAbsolute(targetPath: string): string {
	return path.resolve(targetPath);
}

export class NodeRunRootGitOps implements RunRootGitOps {
	#credentialDir: string | null = null;

	configureRepositoryCredentials(credentials: readonly WorkerGitSshCredential[]): void {
		this.cleanupRepositoryCredentials();
		if (credentials.length === 0) return;
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-repo-auth-"));
		chmodSync(root, 0o700);
		this.#credentialDir = root;
		for (const credential of credentials) {
			const dir = path.join(root, encodeURIComponent(credential.projectKey));
			mkdirSync(dir, { mode: 0o700 });
			const key = path.join(dir, "identity");
			const hosts = path.join(dir, "known_hosts");
			const wrapper = path.join(dir, "ssh");
			writeFileSync(key, `${credential.privateKey.trim()}\n`, { mode: 0o600 });
			writeFileSync(hosts, `${credential.knownHosts.trim()}\n`, { mode: 0o600 });
			writeFileSync(
				wrapper,
				`#!/bin/sh\nexec ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile="${key}" -o UserKnownHostsFile="${hosts}" -o StrictHostKeyChecking=yes -o BatchMode=yes "$@"\n`,
				{ mode: 0o700 },
			);
			setRepositoryGitSshWrapper(credential.projectKey, wrapper);
		}
	}

	cleanupRepositoryCredentials(): void {
		clearRepositoryGitSshWrappers();
		if (this.#credentialDir) rmSync(this.#credentialDir, { recursive: true, force: true });
		this.#credentialDir = null;
	}

	private async runGit(
		args: readonly string[],
		cwd?: string,
		projectKey?: string,
	): Promise<string> {
		const result = await execa(resolveGitBinary(), repositoryGitArgs(args), {
			...(cwd ? { cwd: toAbsolute(cwd) } : {}),
			env: repositoryGitSubprocessEnv(projectKey ?? "", { GIT_TERMINAL_PROMPT: "0" }),
			extendEnv: false,
			stdin: "ignore",
		});
		return result.stdout;
	}

	async writeFile(repoDir: string, filePath: string, content: string): Promise<void> {
		const absolutePath = toAbsolute(path.join(repoDir, filePath));
		mkdirSync(path.dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, content, "utf8");
	}

	async readFile(repoDir: string, filePath: string): Promise<string | null> {
		const absolutePath = toAbsolute(path.join(repoDir, filePath));
		if (!existsSync(absolutePath)) {
			return null;
		}
		return readFileSync(absolutePath, "utf8");
	}

	async clone(repoLocator: string, targetDir: string): Promise<void> {
		const absoluteTargetDir = toAbsolute(targetDir);
		rmSync(absoluteTargetDir, { recursive: true, force: true });
		mkdirSync(path.dirname(absoluteTargetDir), { recursive: true });
		await this.runGit(
			["clone", repoLocator, absoluteTargetDir],
			undefined,
			path.basename(absoluteTargetDir),
		);
	}

	async checkout(repoDir: string, branch: string): Promise<void> {
		await this.runGit(["checkout", branch], repoDir);
	}

	async createBranch(repoDir: string, branchName: string, startPoint: string): Promise<void> {
		await this.runGit(["branch", branchName, startPoint], repoDir);
	}

	async branchExists(repoDir: string, branchName: string): Promise<boolean> {
		try {
			const output = await this.runGit(
				["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`],
				repoDir,
			);
			return output.trim() !== "";
		} catch {
			return false;
		}
	}

	async getHeadSha(repoDir: string): Promise<string> {
		return (await this.runGit(["rev-parse", "HEAD"], repoDir)).trim();
	}

	async listFiles(repoDir: string, pattern: string): Promise<string[]> {
		const absoluteRoot = toAbsolute(repoDir);
		if (!existsSync(absoluteRoot)) {
			return [];
		}
		return (
			await fg(pattern, {
				cwd: absoluteRoot,
				dot: true,
				onlyFiles: true,
				ignore: ["**/.git/**"],
			})
		).sort((a, b) => a.localeCompare(b));
	}
}
