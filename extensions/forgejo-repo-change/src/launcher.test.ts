import { buildProcessLaunchersForTest } from "@leitwerk-dev/extension-runtime/testing";
import type { ForgejoClient, ForgejoIntegration } from "@leitwerk-dev/forgejo";
import type { GitSshIntegration } from "@leitwerk-dev/git-ssh";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureForgejoRepoChangeLauncher, forgejoRepoChangeUiLauncherId } from "./launcher.js";
import { forgejoRepoChangeProcess } from "./process.js";

const repository = {
	id: 23,
	name: "service",
	full_name: "team/service",
	ssh_url: "ssh://git@git.example.test:2222/team/service.git",
	html_url: "https://git.example.test/team/service",
	default_branch: "trunk",
	owner: { login: "team" },
};

function configure(preflight: GitSshIntegration["preflight"] = async () => ({ ok: true })): void {
	configureForgejoRepoChangeLauncher({
		forgejo: {
			profiles: () => ["team"],
			client(profile) {
				if (profile !== "team") throw new Error(`Unexpected profile '${profile}'`);
				return {
					listRepositories: async () => [repository],
					resolveGitIdentity: async () => ({
						name: "Leitwerk Bot",
						email: "leitwerk-bot@noreply.git.example.test",
						provider: "forgejo",
						profile: "team",
						login: "leitwerk-bot",
					}),
				} as ForgejoClient;
			},
		} satisfies ForgejoIntegration,
		woodpecker: { client: () => ({}) as never },
		gitSsh: { profiles: () => ["team"], preflight },
	});
}

function launcher() {
	const value = buildProcessLaunchersForTest(forgejoRepoChangeProcess)?.launchers.get(
		forgejoRepoChangeUiLauncherId,
	)?.ui;
	if (!value) throw new Error("expected Forgejo repository-change UI launcher");
	return value;
}

async function resolveLaunch(prompt: string) {
	const input = {
		forgejoProfile: "team",
		repository: "team/service",
		prompt,
	};
	const resolved = await launcher().resolveLaunchConfig(input, {});
	if (!resolved.ok) throw new Error("expected launch resolution");
	return { input, launchConfig: resolved.launchConfig };
}

describe("Forgejo repository-change UI launcher", () => {
	afterEach(() => configureForgejoRepoChangeLauncher(null));

	it("lists server-authorized profiles and repositories", async () => {
		configure();
		await expect(Promise.resolve(launcher().resolveDefaults?.({}))).resolves.toEqual({
			forgejoProfile: "team",
			repository: "",
			prompt: "",
		});
		await expect(launcher().resolveOptions?.({ forgejoProfile: "team" }, {})).resolves.toEqual({
			forgejoProfile: [{ value: "team", label: "team" }],
			repository: [
				{
					value: "team/service",
					label: "team/service",
					description: "https://git.example.test/team/service",
				},
			],
		});
	});

	it("builds a ticketless launch from authoritative repository metadata", async () => {
		configure();
		const { launchConfig } = await resolveLaunch("Improve the deployment status");
		expect(launchConfig).toMatchObject({
			processId: "forgejo_repo_change_process",
			startTurnId: "generate_plan",
			params: {
				origin: "ui",
				repoLocator: repository.ssh_url,
				baseBranch: "trunk",
				forgejoProfile: "team",
				woodpeckerProfile: "team",
				sshCredentialRef: "team",
				issueNumber: null,
			},
			projects: [
				{
					key: "repo",
					repoLocator: repository.ssh_url,
					baseBranch: "trunk",
					metadata: {
						forgejo: { owner: "team", repo: "service" },
						"leitwerk.gitIdentity": {
							name: "Leitwerk Bot",
							email: "leitwerk-bot@noreply.git.example.test",
							provider: "forgejo",
							profile: "team",
							login: "leitwerk-bot",
						},
					},
				},
			],
		});
		expect(launchConfig.params.workBranch).toMatch(
			/^improve-the-deployment-status-[0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("rejects API-visible repositories without SSH write authorization", async () => {
		const preflight = vi.fn<GitSshIntegration["preflight"]>(async ({ requireWrite }) =>
			requireWrite
				? { ok: false, access: "write", detail: "repository key is read-only" }
				: { ok: true },
		);
		configure(preflight);
		const { input, launchConfig } = await resolveLaunch("Change it");
		const checks = launcher().preparationChecks?.(input, launchConfig) ?? [];
		expect(checks.map((check) => check.id)).toEqual([
			"repository_visibility",
			"ssh_read",
			"ssh_write",
		]);
		const warn = vi.fn();
		const context = {
			signal: new AbortController().signal,
			launchConfig,
			logger: { info() {}, warn },
		};
		await checks[0]?.run(context);
		await checks[1]?.run(context);
		await expect(checks[2]?.run(context)).rejects.toMatchObject({
			message: "SSH write access failed: repository key is read-only",
			safeSummary: expect.stringContaining(
				"Authorize Git SSH profile 'team' for 'team/service' with read/write access",
			),
		});
		expect(warn).toHaveBeenCalledWith(
			"Git SSH write preflight failed: repository key is read-only",
		);
		expect(preflight).toHaveBeenNthCalledWith(2, expect.objectContaining({ requireWrite: true }));
	});

	it("rejects a repository that is not returned by Forgejo", async () => {
		configure();
		await expect(
			launcher().resolveLaunchConfig(
				{
					forgejoProfile: "team",
					repository: "team/hidden",
					prompt: "Change it",
				},
				{},
			),
		).resolves.toMatchObject({
			ok: false,
			errors: [{ fieldId: "repository", code: "custom_rule" }],
		});
	});
});
