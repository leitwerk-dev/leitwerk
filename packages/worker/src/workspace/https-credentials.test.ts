import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { repositoryGitSubprocessEnv, sanitizeWorkerSubprocessEnv } from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { NodeRunRootGitOps } from "./node-run-root-git-ops.js";

describe("repository HTTPS credentials", () => {
	it("supplies Git only the exact HTTPS repository credential and removes restricted files on cleanup", () => {
		const git = new NodeRunRootGitOps();
		git.configureRepositoryCredentials([
			{
				projectKey: "repo",
				kind: "git_https",
				credentialRef: "https:fixture",
				repositoryUrl: "https://forge.test/group/subgroup/repo.git",
				username: "oauth2",
				password: "unique-test-token",
			},
		]);
		let helper = "";
		try {
			const env = repositoryGitSubprocessEnv("repo");
			const helperCommand = env.GIT_CONFIG_VALUE_1 ?? "";
			helper = helperCommand.match(/'([^']+credential\.cjs)'$/)?.[1] ?? "";
			expect(helper).toBeTruthy();
			expect(statSync(helper).mode & 0o777).toBe(0o700);
			expect(statSync(path.dirname(helper)).mode & 0o777).toBe(0o700);
			expect(statSync(path.join(path.dirname(helper), "credential.json")).mode & 0o777).toBe(0o600);
			expect(readFileSync(helper, "utf8")).not.toContain("unique-test-token");
			expect(JSON.stringify(env)).not.toContain("unique-test-token");
			const fill = (url: string) =>
				execFileSync("git", ["credential", "fill"], {
					input: `url=${url}\n\n`,
					encoding: "utf8",
					env,
					stdio: ["pipe", "pipe", "pipe"],
				});
			expect(fill("https://forge.test/group/subgroup/repo.git")).toContain(
				"password=unique-test-token",
			);
			for (const url of [
				"http://forge.test/group/subgroup/repo.git",
				"https://other.test/group/subgroup/repo.git",
				"https://forge.test/team/platform/services/other.git",
				"https://forge.test/group/subgroup/repo.git/other",
				"https://forge.test:8443/group/subgroup/repo.git",
			])
				expect(() => fill(url)).toThrow();
			expect(repositoryGitSubprocessEnv("another").GIT_CONFIG_COUNT).toBeUndefined();
			const ordinary = sanitizeWorkerSubprocessEnv({ ...env, FORGE_API_TOKEN: "server-token" });
			expect(
				Object.keys(ordinary).some(
					(k) =>
						k.startsWith("GIT_CONFIG_") ||
						k.startsWith("LEITWERK_INTERNAL_REPOSITORY") ||
						k === "FORGE_API_TOKEN",
				),
			).toBe(false);
			git.cleanupRepositoryCredentials();
			expect(existsSync(helper)).toBe(false);
			expect(repositoryGitSubprocessEnv("repo").GIT_CONFIG_COUNT).toBeUndefined();
		} finally {
			git.cleanupRepositoryCredentials();
		}
	});
	it("cleans a partially materialized credential batch after a validation error", () => {
		const git = new NodeRunRootGitOps();
		expect(() =>
			git.configureRepositoryCredentials([
				{
					projectKey: "repo",
					kind: "git_https",
					credentialRef: "https:fixture",
					repositoryUrl: "https://token@forge.test/repo.git",
					username: "oauth2",
					password: "test",
				},
			]),
		).toThrow();
		expect(repositoryGitSubprocessEnv("repo").GIT_CONFIG_COUNT).toBeUndefined();
	});
});
