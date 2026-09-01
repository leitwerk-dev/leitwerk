import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	coreHostCapabilities,
	createCapabilityToken,
	type GitSshCredentialMaterial,
	type LeitwerkExtensionModule,
} from "@leitwerk-dev/process-sdk";

const execFileAsync = promisify(execFile);

export const manifest = { id: "git-ssh", version: "0.1.0" } as const;

export interface GitSshAuthorizationPreflightInput {
	credentialRef: string;
	repoLocator: string;
	baseBranch: string;
	requireWrite: boolean;
}

export type GitSshAuthorizationPreflightResult =
	| { ok: true }
	| { ok: false; access: "read" | "write"; detail: string };

export interface GitSshIntegration {
	profiles(): readonly string[];
	preflight(input: GitSshAuthorizationPreflightInput): Promise<GitSshAuthorizationPreflightResult>;
}

export const gitSshIntegration = createCapabilityToken<GitSshIntegration>(
	"@leitwerk-dev/git-ssh.integration",
);

function gitFailureDetail(error: unknown): string {
	if (!error || typeof error !== "object") return "Git SSH access check failed";
	const value = error as { stderr?: unknown; stdout?: unknown; message?: unknown };
	const output =
		typeof value.stderr === "string" && value.stderr.trim()
			? value.stderr
			: typeof value.stdout === "string" && value.stdout.trim()
				? value.stdout
				: typeof value.message === "string"
					? value.message
					: "Git SSH access check failed";
	return output.replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function preflightGitSshAccess(
	input: Omit<GitSshAuthorizationPreflightInput, "credentialRef">,
	material: GitSshCredentialMaterial,
	gitBinary = "git",
): Promise<GitSshAuthorizationPreflightResult> {
	const directory = await mkdtemp(join(tmpdir(), "leitwerk-git-ssh-preflight-"));
	try {
		const keyPath = join(directory, "identity");
		const knownHostsPath = join(directory, "known_hosts");
		const sshPath = join(directory, "ssh");
		await Promise.all([
			writeFile(keyPath, `${material.privateKey.trim()}\n`, { mode: 0o600 }),
			writeFile(knownHostsPath, `${material.knownHosts.trim()}\n`, { mode: 0o600 }),
			writeFile(
				sshPath,
				`#!/bin/sh\nexec ssh -F /dev/null -i "${keyPath}" -o IdentitiesOnly=yes -o UserKnownHostsFile="${knownHostsPath}" -o StrictHostKeyChecking=yes -o BatchMode=yes "$@"\n`,
				{ mode: 0o700 },
			),
		]);
		const env = { ...process.env, GIT_SSH: sshPath, SSH_AUTH_SOCK: "" };
		const ref = `refs/heads/${input.baseBranch}`;
		try {
			await execFileAsync(gitBinary, ["ls-remote", "--exit-code", input.repoLocator, ref], {
				env,
			});
		} catch (error) {
			return { ok: false, access: "read", detail: gitFailureDetail(error) };
		}
		if (!input.requireWrite) return { ok: true };

		try {
			await execFileAsync(gitBinary, ["init", "--quiet", directory], { env });
			await execFileAsync(
				gitBinary,
				["-C", directory, "fetch", "--quiet", "--depth=1", input.repoLocator, ref],
				{ env },
			);
			const probeBranch = `refs/heads/leitwerk/preflight-${process.pid}-${Date.now()}`;
			await execFileAsync(
				gitBinary,
				["-C", directory, "push", "--dry-run", input.repoLocator, `FETCH_HEAD:${probeBranch}`],
				{ env },
			);
			return { ok: true };
		} catch (error) {
			return { ok: false, access: "write", detail: gitFailureDetail(error) };
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function parseProfiles(raw: unknown): Map<string, GitSshCredentialMaterial> {
	const root = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const credentials =
		root.credentials && typeof root.credentials === "object"
			? (root.credentials as Record<string, unknown>)
			: {};
	const profiles = new Map<string, GitSshCredentialMaterial>();
	for (const [ref, value] of Object.entries(credentials)) {
		const profile = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		const privateKey = typeof profile.private_key === "string" ? profile.private_key.trim() : "";
		const knownHosts = typeof profile.known_hosts === "string" ? profile.known_hosts.trim() : "";
		if (!privateKey.includes("BEGIN OPENSSH PRIVATE KEY"))
			throw new Error(`Invalid git_ssh credential '${ref}': an OpenSSH private key is required`);
		const encodedBody = privateKey
			.split(/\r?\n/)
			.filter((line) => !line.startsWith("-----"))
			.join("");
		const decodedHeader = Buffer.from(encodedBody, "base64").subarray(0, 96).toString("latin1");
		if (/ENCRYPTED/.test(privateKey) || decodedHeader.includes("bcrypt"))
			throw new Error(
				`Invalid git_ssh credential '${ref}': encrypted keys requiring a passphrase are unsupported`,
			);
		const hostLines = knownHosts
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"));
		if (hostLines.length === 0 || hostLines.some((line) => line.split(/\s+/).length < 3))
			throw new Error(
				`Invalid git_ssh credential '${ref}': pinned known_hosts entries are required`,
			);
		profiles.set(ref, { privateKey, knownHosts });
	}
	return profiles;
}

const extension: LeitwerkExtensionModule = {
	manifest,
	setupServer(api, config) {
		const deps = api.get(coreHostCapabilities.serverSetup);
		if (!deps || Array.isArray(deps)) return;
		const profiles = parseProfiles(config);
		deps.repositoryCredentials.register({
			kind: "git_ssh",
			resolve: (ref) => profiles.get(ref) ?? null,
		});
		api.provide(gitSshIntegration, {
			profiles: () => [...profiles.keys()].sort(),
			async preflight(input) {
				const material = profiles.get(input.credentialRef);
				if (!material) {
					return {
						ok: false,
						access: "read",
						detail: `Unknown git_ssh credential '${input.credentialRef}'`,
					};
				}
				return preflightGitSshAccess(input, material);
			},
		});
	},
};

export { parseProfiles };
export default extension;
