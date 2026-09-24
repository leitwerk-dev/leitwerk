import { describe, expect, it } from "vitest";
import { parseProfileBindings, resolveProfileBinding } from "./profile-bindings.js";
import { launcherFixture as setup } from "./testing/launcher-fixture.js";

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
			expect(
				f.process.repositoryCredentials?.({ params: result.launchConfig.params, projects: [] }),
			).toEqual([{ projectKey: "repo", kind: "git_ssh", credentialRef: "writer" }]);
		}
		const launch = await f.watcher.resolveLaunchConfig({
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

	it("rejects unavailable Forgejo, CI and SSH profiles before launch", async () => {
		const f = setup();
		expect(await f.launch({ forgejoProfile: "missing" })).toMatchObject({ ok: false });
		for (const mapping of [{ woodpecker_profile: "missing" }, { ssh_credential_ref: "missing" }]) {
			f.configure({ profile_bindings: { team: mapping } });
			expect(await f.launch()).toMatchObject({
				ok: false,
				errors: [{ fieldId: "forgejoProfile" }],
			});
		}
	});

	it("retains the separate SSH read admission check", async () => {
		const f = setup();
		f.preflight.mockImplementation(async (input) =>
			!input.requireWrite ? { ok: false, access: "read", detail: "denied" } : { ok: true },
		);
		const result = await f.launch();
		if (!result.ok) throw new Error("launch");
		const check = f.ui
			.preparationChecks?.({}, result.launchConfig)
			.find((c) => c.id === "ssh_read");
		await expect(
			check?.run({
				signal: new AbortController().signal,
				launchConfig: result.launchConfig,
				logger: { info() {}, warn() {} },
			}),
		).rejects.toThrow("SSH read access failed");
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
