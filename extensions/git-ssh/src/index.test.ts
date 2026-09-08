import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseProfiles, preflightGitSshAccess } from "./index.js";

const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
const tempDirs: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fakeGit(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "leitwerk-fake-git-"));
	tempDirs.push(directory);
	const binary = join(directory, "git");
	await writeFile(
		binary,
		`#!/bin/sh
case "$*" in
  *deny-read*) echo "repository key is not authorized to read" >&2; exit 128 ;;
  *push*deny-write*) echo "repository key is read-only" >&2; exit 128 ;;
esac
exit 0
`,
		{ mode: 0o700 },
	);
	return binary;
}

describe("git ssh profiles", () => {
	it("parses pinned profiles without exposing them through a catalog", () => {
		const profiles = parseProfiles({
			credentials: { default: { private_key: key, known_hosts: "git.example ssh-ed25519 AAAA" } },
		});
		expect(profiles.get("default")).toEqual({
			privateKey: key,
			knownHosts: "git.example ssh-ed25519 AAAA",
		});
	});

	it("checks SSH read and write authorization without pushing", async () => {
		const gitBinary = await fakeGit();
		const material = { privateKey: key, knownHosts: "git.example ssh-ed25519 AAAA" };
		await expect(
			preflightGitSshAccess(
				{
					repoLocator: "ssh://git@git.example/allowed.git",
					baseBranch: "main",
					requireWrite: true,
				},
				material,
				gitBinary,
			),
		).resolves.toEqual({ ok: true });
		await expect(
			preflightGitSshAccess(
				{
					repoLocator: "ssh://git@git.example/deny-read.git",
					baseBranch: "main",
					requireWrite: true,
				},
				material,
				gitBinary,
			),
		).resolves.toMatchObject({ ok: false, access: "read" });
		await expect(
			preflightGitSshAccess(
				{
					repoLocator: "ssh://git@git.example/deny-write.git",
					baseBranch: "main",
					requireWrite: true,
				},
				material,
				gitBinary,
			),
		).resolves.toMatchObject({ ok: false, access: "write" });
	});

	it("requires a key and pinned hosts", () => {
		expect(() =>
			parseProfiles({ credentials: { bad: { private_key: key, known_hosts: "" } } }),
		).toThrow("pinned known_hosts");
		expect(() =>
			parseProfiles({
				credentials: { bad: { private_key: "nope", known_hosts: "git.example ssh-ed25519 AAAA" } },
			}),
		).toThrow("OpenSSH private key");
	});

	it.each([
		"GIT_SSH_COMMAND",
		"core.sshCommand",
	])("uses the selected SSH profile when %s is configured in the server environment", async (override) => {
		const directory = await mkdtemp(join(tmpdir(), "leitwerk-profile-ssh-"));
		tempDirs.push(directory);
		await writeFile(
			join(directory, "ssh"),
			`#!/bin/sh
if [ "$1" = "-F" ] && [ "$2" = "/dev/null" ] && [ "$3" = "-i" ] && [ -f "$4" ]; then
  echo "managed-profile-selected" >&2
fi
exit 1
`,
			{ mode: 0o700 },
		);
		vi.stubEnv("PATH", `${directory}:${process.env.PATH ?? ""}`);
		vi.stubEnv("GIT_SSH_COMMAND", override === "GIT_SSH_COMMAND" ? "false" : undefined);
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "core.sshCommand");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "false");
		const result = await preflightGitSshAccess(
			{
				repoLocator: "ssh://git@git.example.invalid/profile.git",
				baseBranch: "main",
				requireWrite: false,
			},
			{ privateKey: key, knownHosts: "git.example.invalid ssh-ed25519 AAAA" },
		);
		expect(result).toMatchObject({
			ok: false,
			access: "read",
			detail: expect.stringContaining("managed-profile-selected"),
		});
	});
});
