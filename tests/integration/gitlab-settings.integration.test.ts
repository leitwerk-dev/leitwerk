import coding, { repositoryInstructions } from "@leitwerk-dev/coding";
import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import gitlab from "@leitwerk-dev/gitlab";
import { createGitLabRepoChange } from "@leitwerk-dev/gitlab-repo-change";
import { repositorySettingsIdentity } from "@leitwerk-dev/process-sdk";
import { fixtureModelProviders } from "@leitwerk-dev/test-support";
import { createPersistentIntegrationFixture } from "@leitwerk-dev/test-support/integration";
import { expect, it, onTestFinished, vi } from "vitest";

const project = {
	id: 42,
	path_with_namespace: "team/repo",
	web_url: "https://gitlab.test/team/repo",
	http_url_to_repo: "https://gitlab.test/team/repo.git",
	ssh_url_to_repo: "git@gitlab.test:team/repo.git",
	default_branch: "main",
};
async function fixture() {
	const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
		const pathname = new URL(String(url)).pathname;
		if (pathname.endsWith("/user"))
			return Response.json({ username: "bot", name: "Bot", email: "bot@example.test" });
		if (pathname.endsWith("/projects/42")) return Response.json(project);
		if (pathname.endsWith("/projects")) return Response.json([project]);
		throw new Error(`Unexpected GitLab request: ${pathname}`);
	});
	onTestFinished(() => request.mockRestore());
	const change = createGitLabRepoChange({ docker: false });
	const storage = createPersistentIntegrationFixture("leitwerk-gitlab-settings-", (config) => {
		config.components = { repo: { repo: project.ssh_url_to_repo, default_branch: "main" } };
		config.extensions.gitlab = {
			profiles: { test: { base_url: "https://gitlab.test", token: "fixture" } },
		};
		config.pi.model_profiles = ["title", "implementation"].map((id) => ({
			id,
			provider: "fixture",
			model_id: "fixture-model",
			thinking_level: "off",
		}));
		config.pi.process_title_generation.model_profile = "title";
	});
	onTestFinished(() => storage.dispose());
	const harness = await storage.open({
		listen: false,
		extensionCatalog: buildExtensionCatalogFromModules([
			coding,
			{
				manifest: { id: "git-ssh", version: "1.0.0" },
				setupServer(api) {
					api.provide(gitSshIntegration, {
						profiles: () => ["test"],
						async preflight() {
							throw new Error("Settings fixture does not admit repository launches");
						},
					});
				},
			},
			{
				...gitlab,
				modelProviders: fixtureModelProviders({
					id: "fixture",
					modelId: "fixture-model",
					piProvider: "openai",
					server: true,
				}),
			},
			change.extension,
		]),
	});
	const settings = harness.ctx.deps.scopedSettingsService;
	if (!settings) throw new Error("Missing scoped settings service");
	return { ...harness.ctx.deps, settings, change };
}

it("promotes saved GitLab SSH settings during discovery and carries both verified aliases into launches", async () => {
	const { settings, change } = await fixture();
	const locator = settings
		.listScopes()
		.subjects.find((subject) => subject.identity === `locator:${project.ssh_url_to_repo}`);
	if (!locator) throw new Error("Missing SSH repository scope");
	settings.write({
		subjectId: locator.id,
		key: repositoryInstructions.key,
		value: "Required repository guidance",
		mode: "replace",
		reset: false,
		expectedRevision: 0,
		actor: ADMIN_ACTOR,
	});
	await settings.refresh();
	const canonical = settings
		.listScopes()
		.subjects.find(
			(subject) => subject.identity === repositorySettingsIdentity(project.web_url, project.id),
		);
	if (!canonical) throw new Error("Missing canonical GitLab scope");
	expect(canonical.id).toBe(locator.id);
	expect(settings.resolve(repositoryInstructions, { repository: canonical.id }).value).toBe(
		"Required repository guidance",
	);
	const launch = await change.launcher.launcher.ui?.resolveLaunchConfig(
		{
			gitlabProfile: "test",
			gitSshProfile: "test",
			repository: "42",
			prompt: "Change the repository",
		},
		{},
	);
	if (!launch?.ok) throw new Error("Expected a valid GitLab launch");
	expect(launch.launchConfig.projects?.[0].settingsRepository?.aliases).toEqual([
		project.http_url_to_repo,
		project.ssh_url_to_repo,
	]);
});

it("uses the implementation default for commit messages when a different title model is configured", async () => {
	const { settings, processes, processModelPolicy } = await fixture();
	settings.write({
		subjectId: "instance",
		key: "coding.implementation_model",
		value: "implementation",
		mode: "replace",
		reset: false,
		expectedRevision: 0,
		actor: ADMIN_ACTOR,
	});
	const process = processes.create({
		processId: "gitlab_repo_change_process",
		selectedTurnId: "generate_commit_message",
		lifecycleStatus: "waiting",
	});
	expect(
		processModelPolicy.evaluate({
			kind: "process_turn",
			process,
			turnId: "generate_commit_message",
		}),
	).toMatchObject({ ok: true, selection: { modelProfileId: "implementation" } });
	expect(settings.capture(process, "generate_commit_message")?.values).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ key: "coding.implementation_model", value: "implementation" }),
		]),
	);
});
