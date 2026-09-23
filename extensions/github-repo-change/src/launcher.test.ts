import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalGitHubAdapter } from "@leitwerk-dev/github/testing";
import { expect, it } from "vitest";
import { createGitHubRepoChange } from "./index.js";
import { parseProfileBindings } from "./profile-bindings.js";

it("pins server SSH wiring, rejects unknown profiles, and generates a fresh replay branch", async ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "github-launcher-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const provider = new LocalGitHubAdapter({
		root,
		baseUrl: "https://github.test",
		seeds: [{ owner: "team", name: "repo" }],
	});
	const { launcher, process } = createGitHubRepoChange({ docker: false });
	launcher.configure({
		github: { profiles: () => ["team"], client: () => provider.client() },
		gitSsh: { profiles: () => ["writer"], preflight: async () => ({ ok: true }) },
		profileBindings: parseProfileBindings({
			profile_bindings: { team: { ssh_credential_ref: "writer" } },
		}),
	});
	const ui = launcher.launcher.ui;
	if (!ui) throw new Error("Missing UI");
	const input = {
		githubProfile: "team",
		repository: "team/repo",
		prompt: "Change readme",
		sshCredentialRef: "attacker",
	};
	const first = await ui.resolveLaunchConfig(input, {});
	const second = await ui.resolveLaunchConfig(input, {});
	expect(first.ok).toBe(true);
	expect(second.ok).toBe(true);
	if (!first.ok || !second.ok) throw new Error("Launch failed");
	expect(first.launchConfig.params).toMatchObject({ sshCredentialRef: "writer", origin: "ui" });
	expect(first.launchConfig.params.workBranch).not.toBe(second.launchConfig.params.workBranch);
	expect(first.launchConfig.projects?.[0].metadata).toMatchObject({
		github: { owner: "team", repo: "repo", profile: "team" },
	});
	expect(await ui.resolveLaunchConfig({ ...input, githubProfile: "unknown" }, {})).toMatchObject({
		ok: false,
	});
	expect(process.runtime).toEqual({ docker: false });
	launcher.configure(null);
	expect(() => ui.resolveDefaults?.({})).toThrow("not configured");
});
