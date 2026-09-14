import { buildProcessLaunchersForTest } from "@leitwerk-dev/extension-runtime/testing";
import { forgejoIntegration } from "@leitwerk-dev/forgejo";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { ProcessWatcherDefinition } from "@leitwerk-dev/process-sdk";
import { woodpeckerIntegration } from "@leitwerk-dev/woodpecker";
import { describe, expect, it, vi } from "vitest";
import { createForgejoRepoChange } from "./index.js";
import { forgejoRepoChangeUiLauncherId, type LauncherDependencies } from "./launcher.js";
import { parseProfileBindings, resolveProfileBinding } from "./profile-bindings.js";

function setup(profile = "team", config: unknown = {}, docker = false) {
	const value = createForgejoRepoChange({ docker });
	const repository = {
		id: 7,
		name: "garden",
		full_name: "examples/garden",
		owner: { login: "examples" },
		ssh_url: "ssh://git@forgejo.example/examples/garden.git",
		default_branch: "main",
		html_url: "https://forgejo.example/examples/garden",
	};
	const preflight = vi.fn<LauncherDependencies["gitSsh"]["preflight"]>(async () => ({ ok: true }));
	const dependencies: LauncherDependencies = {
		forgejo: {
			profiles: () => [profile],
			client: () =>
				({
					listRepositories: async () => [
						repository,
						{ ...repository, id: 8, name: "workshop", full_name: "examples/workshop" },
					],
					resolveGitIdentity: async () => ({
						provider: "forgejo",
						profile,
						login: "garden-bot",
						name: "Garden Bot",
						email: "garden-bot@forgejo.example",
					}),
				}) as never,
		},
		woodpecker: {
			client: (name) => {
				if (![profile, "ci"].includes(name)) throw new Error("unknown");
				return {} as never;
			},
		},
		gitSsh: { profiles: () => [profile, "writer"], preflight },
	};
	const stops: Array<() => void> = [];
	const api = {
		require: (token: unknown) =>
			token === forgejoIntegration
				? dependencies.forgejo
				: token === gitSshIntegration
					? dependencies.gitSsh
					: token === woodpeckerIntegration
						? dependencies.woodpecker
						: undefined,
		onStop: (stop: () => void) => stops.push(stop),
	};
	const configure = (config: unknown) => value.extension.setupServer?.(api as never, config);
	configure(config);
	const ui = buildProcessLaunchersForTest(value.process)?.launchers.get(
		forgejoRepoChangeUiLauncherId,
	)?.ui;
	if (!ui) throw new Error("Missing launcher");
	return {
		...value,
		dependencies,
		preflight,
		repository,
		ui,
		configure,
		stop: () => {
			for (const stop of stops) stop();
		},
		launch: (input: Record<string, unknown> = {}) =>
			ui.resolveLaunchConfig(
				{
					forgejoProfile: profile,
					repository: "examples/garden",
					prompt: "Document watering",
					...input,
				},
				{},
			),
	};
}

describe("server-owned delivery composition", () => {
	it("uses same-name defaults and rejects malformed mappings", () => {
		expect(resolveProfileBinding(parseProfileBindings(undefined), "team")).toEqual({
			woodpeckerProfile: "team",
			sshCredentialRef: "team",
		});
		expect(
			parseProfileBindings({ profile_bindings: { team: { woodpecker_profile: "ci" } } }).team,
		).toEqual({ woodpeckerProfile: "ci", sshCredentialRef: "team" });
		for (const profile_bindings of [
			null,
			[],
			"team",
			{ team: null },
			{ team: [] },
			{ team: "ci" },
			{ " ": {} },
			{ team: { woodpecker_profile: " " } },
			{ team: { ssh_credential_ref: 3 } },
			{ team: { ssh_credential_ref: null } },
			{ team: { typo: "ci" } },
		])
			expect(() => parseProfileBindings({ profile_bindings })).toThrow();
	});

	it("resolves UI and issue launches through one mapping and pins two project bindings", async () => {
		const f = setup("team", {
			profile_bindings: { team: { woodpecker_profile: "ci", ssh_credential_ref: "writer" } },
		});
		for (const repository of ["examples/garden", "examples/workshop"]) {
			const result = await f.launch({
				repository,
				woodpeckerProfile: "attacker",
				sshCredentialRef: "attacker",
				docker: true,
				runtime: { docker: true },
			});
			if (!result.ok) throw new Error("launch");
			expect(result.launchConfig.params).toMatchObject({
				forgejoProfile: "team",
				woodpeckerProfile: "ci",
				sshCredentialRef: "writer",
			});
			expect(result.launchConfig.projects?.[0].metadata).toMatchObject({
				forgejo: { profile: "team", repo: repository.split("/")[1] },
				woodpecker: { profile: "ci" },
				"leitwerk.gitIdentity": { login: "garden-bot" },
			});
			expect(result.launchConfig.params).not.toHaveProperty("docker");
			f.configure({
				profile_bindings: { team: { ssh_credential_ref: "writer", woodpecker_profile: "ci" } },
			});
			expect(
				f.process.repositoryCredentials?.({ params: result.launchConfig.params, projects: [] }),
			).toEqual([{ projectKey: "repo", kind: "git_ssh", credentialRef: "writer" }]);
		}
		let watcher: ProcessWatcherDefinition | undefined;
		f.process.watchers?.({
			watcher: (value) => {
				watcher = value as ProcessWatcherDefinition;
			},
		});
		const launch = await watcher?.resolveLaunchConfig({
			profile: "team",
			repository: f.repository,
			issue: {
				number: 42,
				title: "Water",
				body: "Weekly",
				html_url: "https://forgejo.example/issues/42",
			},
			labels: { trigger: "use-leitwerk", done: "leitwerk-done" },
		});
		expect(launch?.params).toMatchObject({
			woodpeckerProfile: "ci",
			sshCredentialRef: "writer",
			origin: "issue",
		});
		f.configure({});
		expect(launch?.params).toMatchObject({ woodpeckerProfile: "ci", sshCredentialRef: "writer" });
		const next = await f.launch();
		expect(next).toMatchObject({
			ok: true,
			launchConfig: { params: { woodpeckerProfile: "team", sshCredentialRef: "team" } },
		});
	});

	it("rejects unavailable Forgejo, CI, SSH and repository access before launch", async () => {
		const f = setup();
		for (const input of [{ forgejoProfile: "missing" }, { repository: "examples/hidden" }])
			expect(await f.launch(input)).toMatchObject({ ok: false });
		for (const mapping of [{ woodpecker_profile: "missing" }, { ssh_credential_ref: "missing" }]) {
			f.configure({ profile_bindings: { team: mapping } });
			expect(await f.launch()).toMatchObject({
				ok: false,
				errors: [{ fieldId: "forgejoProfile" }],
			});
		}
	});

	it.each([
		"read",
		"write",
	] as const)("retains the separate SSH %s admission check", async (access) => {
		const f = setup();
		f.preflight.mockImplementation(async (input) =>
			input.requireWrite === (access === "write")
				? { ok: false, access, detail: "denied" }
				: { ok: true },
		);
		const result = await f.launch();
		if (!result.ok) throw new Error("launch");
		const check = f.ui
			.preparationChecks?.({}, result.launchConfig)
			.find((c) => c.id === `ssh_${access}`);
		await expect(
			check?.run({
				signal: new AbortController().signal,
				launchConfig: result.launchConfig,
				logger: { info() {}, warn() {} },
			}),
		).rejects.toThrow(`SSH ${access} access failed`);
	});

	it("keeps runtime and launcher configuration independent across catalogs and shutdown", async () => {
		const one = setup("one", {}, true),
			two = setup("two", {}, false);
		expect(one.process.runtime).toEqual({ docker: true });
		expect(two.process.runtime).toEqual({ docker: false });
		expect([...one.process.turns.keys()]).toEqual([...two.process.turns.keys()]);
		expect(one.process.turns).not.toBe(two.process.turns);
		expect(await one.launch()).toMatchObject({
			ok: true,
			launchConfig: { params: { forgejoProfile: "one" } },
		});
		expect(await two.launch()).toMatchObject({
			ok: true,
			launchConfig: { params: { forgejoProfile: "two" } },
		});
		one.stop();
		await expect(one.launch()).rejects.toThrow("not configured");
		expect(await two.launch()).toMatchObject({ ok: true });
	});
});
