import { ADMIN_ACTOR } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import gitlabExtension, { gitlabIntegration } from "@leitwerk-dev/gitlab";
import jira from "@leitwerk-dev/jira";
import { createJiraGitLabLauncher } from "@leitwerk-dev/jira-gitlab-change";
import {
	createCapabilityAccessor,
	repositorySettingsIdentity,
	scopedSettingsCapability,
} from "@leitwerk-dev/process-sdk";
import { createToolCollector } from "@leitwerk-dev/test-support";
import { createPersistentIntegrationFixture } from "@leitwerk-dev/test-support/integration";
import { expect, it, onTestFinished, vi } from "vitest";

it("retains mapped repository names across a server restart without GitLab reads or mapping rewrites", async () => {
	const storage = createPersistentIntegrationFixture("leitwerk-repository-labels-");
	onTestFinished(() => storage.dispose());
	let name = "team/searched";
	const respond = async (input: URL | Request | string) => {
		const origin = new URL(String(input)).origin;
		const path = origin === "https://gitlab.test" ? name : "other/searched";
		return Response.json([
			{
				id: 43,
				path_with_namespace: path,
				web_url: `${origin}/${path}`,
				http_url_to_repo: `${origin}/${path}.git`,
				ssh_url_to_repo: `git@${new URL(origin).hostname}:${path}.git`,
				default_branch: "main",
			},
		]);
	};
	const request = vi.spyOn(globalThis, "fetch").mockImplementation(respond);
	onTestFinished(() => request.mockRestore());
	async function open() {
		const launcher = createJiraGitLabLauncher();
		const harness = await storage.open({
			listen: false,
			extensionCatalog: buildExtensionCatalogFromModules([
				{ manifest: jira.manifest, scopedSettings: jira.scopedSettings },
				{
					manifest: { id: "jira-gitlab-change", version: "1" },
					scopedSettings: { settings: [launcher.mapping] },
				},
			]),
		});
		const settings = harness.ctx.deps.scopedSettingsService;
		if (!settings) throw new Error("Missing settings service");
		const capabilities = createCapabilityAccessor([
			{ token: scopedSettingsCapability, value: settings },
		]);
		await gitlabExtension.setupServer?.(
			{ ...createToolCollector().api, ...capabilities },
			{
				profiles: {
					team: { base_url: "https://gitlab.test", token: "fixture-token" },
					other: { base_url: "https://other.test", token: "fixture-token" },
				},
			},
		);
		const gitlab = capabilities.require(gitlabIntegration);
		if (Array.isArray(gitlab)) throw new Error("Expected one GitLab integration");
		launcher.configure({
			settings,
			gitlab,
			jira: {
				profiles: () => [],
				client: () => {
					throw new Error("Labels do not read Jira");
				},
			},
			ssh: { profiles: () => ["write"], preflight: async () => ({ ok: true }) },
		});
		return { settings, launcher };
	}
	let current = await open();
	const component = current.settings.discover({
		scopeType: "jira.component",
		identity: "component",
		label: "DEMO / Shared",
	});
	current.settings.discover({
		scopeType: "repository",
		identity: repositorySettingsIdentity("https://gitlab.test", 42),
		label: "team/legacy",
	});
	const legacy = JSON.stringify({
		origin: "https://gitlab.test",
		projectId: 42,
		gitlabProfile: "team",
	});
	const key = current.launcher.mapping.key;
	const choices = await current.settings.choices(component.id, key, "searched");
	expect(choices).toHaveLength(4);
	const values = [legacy, ...choices.map((choice) => choice.value)];
	current.settings.write({
		subjectId: component.id,
		key,
		value: values,
		mode: "replace",
		reset: false,
		expectedRevision: 0,
		actor: ADMIN_ACTOR,
	});
	const saved = (await current.settings.preview(component.id)).fields[0].override;
	await storage.close();
	request.mockClear();
	request.mockRejectedValue(new Error("GitLab is offline"));
	current = await open();
	const field = (await current.settings.preview(component.id)).fields[0];
	expect(field.error).toBeNull();
	expect(field.choices.map((choice) => choice.label)).toEqual([
		"team/legacy · team / HTTPS",
		"team/searched · team / HTTPS",
		"team/searched · team / write",
		"other/searched · other / HTTPS",
		"other/searched · other / write",
	]);
	expect(field.override).toEqual(saved);
	expect(request).not.toHaveBeenCalled();
	await expect(current.settings.refresh()).rejects.toThrow("network unavailable");
	expect((await current.settings.preview(component.id)).fields[0].choices).toEqual(field.choices);
	request.mockReset();
	name = "team/renamed";
	request.mockImplementation(respond);
	await current.settings.refresh();
	const renamed = (await current.settings.preview(component.id)).fields[0];
	expect(renamed.choices[1].label).toBe("team/renamed · team / HTTPS");
	expect(renamed.override).toEqual(saved);
	expect(
		current.settings.findSubject(
			"repository",
			repositorySettingsIdentity("https://unknown.test", 43),
		),
	).toBeNull();
	expect(
		current.launcher.mapping.choiceLabel?.(
			JSON.stringify({
				origin: "https://unknown.test",
				projectId: 43,
				gitlabProfile: "team",
			}),
		),
	).toBe("Repository 43 · team / HTTPS");
});
