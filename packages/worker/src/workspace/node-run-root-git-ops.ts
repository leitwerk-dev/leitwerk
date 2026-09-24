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
	clearRepositoryGitHttpsHelpers,
	clearRepositoryGitSshWrappers,
	repositoryGitArgs,
	repositoryGitSubprocessEnv,
	repositoryHttpsUrl,
	setRepositoryGitHttpsHelper,
	setRepositoryGitSshWrapper,
} from "@leitwerk-dev/process-sdk";
import { resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import type { WorkerRepositoryCredential } from "@leitwerk-dev/worker-protocol";
import { execa } from "execa";
import fg from "fast-glob";
import type { RunRootGitOps } from "./run-root.js";

export class NodeRunRootGitOps implements RunRootGitOps {
	#credentialDir: string | null = null;

	configureRepositoryCredentials(credentials: readonly WorkerRepositoryCredential[]): void {
		this.cleanupRepositoryCredentials();
		if (credentials.length === 0) return;
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-repo-auth-"));
		chmodSync(root, 0o700);
		this.#credentialDir = root;
		try {
			for (const credential of credentials) {
				const dir = path.join(root, encodeURIComponent(credential.projectKey));
				mkdirSync(dir, { mode: 0o700 });
				if (credential.kind === "git_https") {
					const url = repositoryHttpsUrl(credential.repositoryUrl);
					writeFileSync(
						path.join(dir, "credential.json"),
						JSON.stringify({
							host: url.host,
							path: url.pathname.slice(1),
							username: credential.username,
							password: credential.password,
						}),
						{ mode: 0o600 },
					);
					const helper = path.join(dir, "credential.cjs");
					writeFileSync(helper, HTTPS_CREDENTIAL_HELPER, { mode: 0o700 });
					setRepositoryGitHttpsHelper(credential.projectKey, helper);
					continue;
				}
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
		} catch (error) {
			this.cleanupRepositoryCredentials();
			throw error;
		}
	}

	cleanupRepositoryCredentials(): void {
		clearRepositoryGitSshWrappers();
		clearRepositoryGitHttpsHelpers();
		if (this.#credentialDir) rmSync(this.#credentialDir, { recursive: true, force: true });
		this.#credentialDir = null;
	}

	private async runGit(
		args: readonly string[],
		cwd?: string,
		projectKey?: string,
	): Promise<string> {
		const result = await execa(resolveGitBinary(), repositoryGitArgs(args), {
			...(cwd ? { cwd: path.resolve(cwd) } : {}),
			env: repositoryGitSubprocessEnv(projectKey ?? "", { GIT_TERMINAL_PROMPT: "0" }),
			extendEnv: false,
			stdin: "ignore",
		});
		return result.stdout;
	}

	async writeFile(repoDir: string, filePath: string, content: string): Promise<void> {
		const absolutePath = path.resolve(path.join(repoDir, filePath));
		mkdirSync(path.dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, content, "utf8");
	}

	async readFile(repoDir: string, filePath: string): Promise<string | null> {
		const absolutePath = path.resolve(path.join(repoDir, filePath));
		if (!existsSync(absolutePath)) {
			return null;
		}
		return readFileSync(absolutePath, "utf8");
	}

	async clone(repoLocator: string, targetDir: string): Promise<void> {
		const absoluteTargetDir = path.resolve(targetDir);
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
		const absoluteRoot = path.resolve(repoDir);
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

// The secret is read only by this short-lived helper, never embedded in its source or argv.
const HTTPS_CREDENTIAL_HELPER = `const fs = require('node:fs');
if (process.argv[2] !== 'get') process.exit(0);
const input = fs.readFileSync(0, 'utf8');
const fields = Object.create(null);
for (const line of input.split('\\n')) {
  const i = line.indexOf('=');
  if (i < 0) continue;
  const key = line.slice(0, i);
  // Git >= 2.46 advertises repeatable capability[] lines; only single-valued keys are matched.
  if (key.endsWith('[]')) continue;
  if (Object.hasOwn(fields, key)) process.exit(0);
  fields[key] = line.slice(i + 1);
}
const c = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'credential.json'), 'utf8'));
if (fields.protocol !== 'https' || fields.host !== c.host || fields.path !== c.path ||
    (fields.username && fields.username !== c.username)) process.exit(0);
process.stdout.write('username=' + c.username + '\\npassword=' + c.password + '\\n\\n');
`;
