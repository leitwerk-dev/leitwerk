import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalGitLabAdapter } from "@leitwerk-dev/gitlab/testing";
import { expect, it } from "vitest";
import { createGitLabRepoChange } from "./index.js";

it("defaults both bypasses off and preserves them on relaunch with SSH-only worker credentials", async ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "gitlab-launcher-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const provider = new LocalGitLabAdapter(root);
	const repository = provider.addProject("team/repo", "git@gitlab.test:team/repo.git");
	const { launcher, process } = createGitLabRepoChange({ docker: false });
	launcher.configure(
		{ profiles: () => ["team"], client: () => provider.client() },
		{ profiles: () => ["writer"], preflight: async () => ({ ok: true }) },
	);
	const ui = launcher.launcher.ui;
	if (!ui?.resolveRelaunchInput) throw new Error("Missing relaunch support");
	expect(await ui.resolveDefaults?.({})).toMatchObject({
		skipPlanDecision: false,
		skipSimplification: false,
	});
	const input = {
		gitlabProfile: "team",
		gitSshProfile: "writer",
		repository: String(repository.id),
		prompt: "Update the readme",
		skipPlanDecision: true,
		skipSimplification: true,
	};
	const first = await ui.resolveLaunchConfig(input, {});
	const replay = await ui.resolveLaunchConfig(await ui.resolveRelaunchInput(input, {}), {});
	if (!first.ok || !replay.ok) throw new Error("Launch failed");
	for (const launch of [first.launchConfig, replay.launchConfig]) {
		expect(launch.params).toMatchObject({
			skipPlanDecision: true,
			skipSimplification: true,
			gitSshProfile: "writer",
			repoLocator: repository.ssh_url_to_repo,
		});
		expect(
			process.repositoryCredentials?.({
				params: launch.params,
				projects: (launch.projects ?? []).map((project) => ({
					...project,
					workBranch: project.workBranch ?? null,
				})),
			}),
		).toEqual([{ projectKey: "repo", kind: "git_ssh", credentialRef: "writer" }]);
	}
	expect(first.launchConfig.params.workBranch).not.toBe(replay.launchConfig.params.workBranch);
	const issue = provider.createIssue(repository.id, "Change", ["leitwerk-skip-simplification"]);
	const params = { ...first.launchConfig.params, origin: "issue" as const, issueNumber: issue.iid };
	expect(await launcher.workflow.planDecision?.(params)).toMatchObject({ skip: false });
	expect(await launcher.workflow.simplification?.(params)).toMatchObject({ skip: true });
	await expect(
		launcher.workflow.simplification?.({
			...params,
			gitlabOrigin: "https://other.test",
			issueNumber: -1,
		}),
	).rejects.toThrow("installation changed");
});
