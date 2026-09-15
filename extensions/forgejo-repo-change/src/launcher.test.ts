import { describe, expect, it, vi } from "vitest";
import { launcherFixture } from "./testing/launcher-fixture.js";

describe("Forgejo repository-change UI launcher", () => {
	it("lists server-authorized profiles and repositories", async () => {
		const { ui, repository } = launcherFixture();
		await expect(Promise.resolve(ui.resolveDefaults?.({}))).resolves.toEqual({
			forgejoProfile: "team",
			repository: "",
			prompt: "",
		});
		await expect(ui.resolveOptions?.({ forgejoProfile: "team" }, {})).resolves.toEqual({
			forgejoProfile: [{ value: "team", label: "team" }],
			repository: [repository.full_name, "examples/workshop"].map((name) => ({
				value: name,
				label: name,
				description: repository.html_url,
			})),
		});
	});

	it("builds a ticketless launch from authoritative repository metadata", async () => {
		const f = launcherFixture();
		const result = await f.launch({ prompt: "Improve the deployment status" });
		if (!result.ok) throw new Error("expected launch resolution");
		const { launchConfig } = result;
		expect(launchConfig).toMatchObject({
			processId: "forgejo_repo_change_process",
			startTurnId: "generate_plan",
			params: {
				origin: "ui",
				repoLocator: f.repository.ssh_url,
				baseBranch: "trunk",
				forgejoProfile: "team",
				woodpeckerProfile: "team",
				sshCredentialRef: "team",
				issueNumber: null,
			},
			projects: [
				{
					key: "repo",
					repoLocator: f.repository.ssh_url,
					baseBranch: "trunk",
					metadata: {
						forgejo: { owner: "examples", repo: "garden" },
						"leitwerk.gitIdentity": f.identity,
					},
				},
			],
		});
		expect(launchConfig.params.workBranch).toMatch(
			/^improve-the-deployment-status-[0-9a-f]{3}-[0-9a-f]{12}$/,
		);
	});

	it("rejects API-visible repositories without SSH write authorization", async () => {
		const f = launcherFixture();
		f.preflight.mockImplementation(async ({ requireWrite }) =>
			requireWrite
				? { ok: false, access: "write", detail: "repository key is read-only" }
				: { ok: true },
		);
		const result = await f.launch();
		if (!result.ok) throw new Error("expected launch resolution");
		const { launchConfig } = result;
		const checks = f.ui.preparationChecks?.({}, launchConfig) ?? [];
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
				"Authorize Git SSH profile 'team' for 'examples/garden' with read/write access",
			),
		});
		expect(warn).toHaveBeenCalledWith(
			"Git SSH write preflight failed: repository key is read-only",
		);
		expect(f.preflight).toHaveBeenNthCalledWith(2, expect.objectContaining({ requireWrite: true }));
	});

	it("rejects a repository that is not returned by Forgejo", async () => {
		await expect(
			launcherFixture().launch({ repository: "examples/hidden" }),
		).resolves.toMatchObject({
			ok: false,
			errors: [{ fieldId: "repository", code: "custom_rule" }],
		});
	});
});
