import { mkdirSync } from "node:fs";
import coding from "@leitwerk-dev/coding";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import { gitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { GitLabIntegration } from "@leitwerk-dev/gitlab";
import { setupGitLabIntegration } from "@leitwerk-dev/gitlab/testing";
import { createGitLabRepoChange } from "@leitwerk-dev/gitlab-repo-change";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { expect, expectNoPageOverflow, test } from "./fixtures.js";

const mapping: LeitwerkExtensionModule = {
	manifest: { id: "mapping-test", version: "1.0.0" },
	scopedSettings: {
		settings: [
			{
				key: "mapping-test.repositories",
				schemaVersion: 1,
				scopes: ["instance"],
				merge: "replace",
				defaultValue: ["unavailable"],
				schema: {
					parse(value) {
						if (!Array.isArray(value)) throw new Error("Choose repositories");
						return value;
					},
				},
				form: {
					label: "GitLab repositories",
					group: "Repository mapping",
					control: "multiselect",
					description: "Repositories used for this Jira component.",
				},
				choices: () => [
					{ value: "service", label: "team/service · team / git-ssh-team" },
					{ value: "client", label: "team/client · team / git-ssh-team" },
				],
			},
		],
	},
};
test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-change-controls-",
		createExtensionCatalog: () =>
			buildExtensionCatalogFromModules([
				coding,
				mapping,
				{
					manifest: { id: "gitlab", version: "1.0.0" },
					setupServer(api) {
						setupGitLabIntegration(api, {
							profiles: () => ["team"],
							client: () => ({
								baseUrl: "https://gitlab.test",
								listProjects: async () => [
									{
										id: 1,
										path_with_namespace: "team/service",
										default_branch: "main",
										web_url: "https://gitlab.test/team/service",
										http_url_to_repo: "https://gitlab.test/team/service.git",
										ssh_url_to_repo: "git@gitlab.test:team/service.git",
									},
								],
							}),
						} as unknown as GitLabIntegration);
					},
				},
				{
					manifest: { id: "git-ssh", version: "1.0.0" },
					setupServer(api) {
						api.provide(gitSshIntegration, {
							profiles: () => ["team"],
							preflight: async () => ({ ok: true }),
						});
					},
				},
				createGitLabRepoChange({ docker: false }).extension,
			]),
	},
});

test("searchable mappings keep selected unavailable values and recover conflicting drafts with the keyboard", async ({
	page,
	leitwerk,
}) => {
	void leitwerk;
	await page.goto("/settings");
	const field = page.getByRole("region", { name: "GitLab repositories", exact: true });
	await field.getByRole("button", { name: "Override", exact: true }).click();
	const search = field.getByRole("searchbox");
	await expect(search).toBeFocused();
	await search.fill("service");
	await expect(field.getByLabel("unavailable (unavailable)", { exact: true })).toBeChecked();
	await field.getByLabel("team/service · team / git-ssh-team").focus();
	await page.keyboard.press("Space");
	await expect(field.getByLabel("team/service · team / git-ssh-team")).toBeChecked();
	const changed = await page.request.put("/api/settings/overrides", {
		data: {
			subjectId: "instance",
			key: "mapping-test.repositories",
			value: ["client"],
			mode: "replace",
			expectedRevision: 0,
		},
	});
	expect(changed.ok()).toBe(true);
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.getByRole("alert")).toContainText("changed since");
	await expect(field.getByLabel("team/service · team / git-ssh-team")).toBeChecked();
	await field.getByRole("button", { name: "Keep draft and use latest revision" }).click();
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.getByRole("status")).toContainText("Saved");
	await field.getByRole("button", { name: "Edit override" }).click();
	await expect(field.getByLabel("unavailable (unavailable)", { exact: true })).toBeChecked();
	mkdirSync(".impeccable/review", { recursive: true });
	await field.screenshot({ path: ".impeccable/review/settings-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByRole("button", { name: "Close navigation" })).not.toBeVisible();
	await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
	await expectNoPageOverflow(page);
	await field.screenshot({ path: ".impeccable/review/settings-mobile.png" });
});

test("launcher presents both unchecked skip controls on desktop and mobile", async ({
	page,
	leitwerk,
}) => {
	void leitwerk;
	await page.setViewportSize({ width: 1280, height: 1100 });
	await page.goto("/");
	await page.getByText("GitLab Repo Change", { exact: true }).first().click();
	const approval = page.getByLabel("Skip plan approval", { exact: true });
	const simplification = page.getByLabel("Skip simplification", { exact: true });
	await expect(approval).not.toBeChecked();
	await expect(simplification).not.toBeChecked();
	await approval.focus();
	await page.keyboard.press("Space");
	await expect(approval).toBeChecked();
	await simplification.focus();
	await page.keyboard.press("Space");
	await expect(simplification).toBeChecked();
	mkdirSync(".impeccable/review", { recursive: true });
	await approval.evaluate((element) => element.blur());
	await page.screenshot({
		path: ".impeccable/review/launcher-desktop.png",
		fullPage: true,
		animations: "disabled",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByRole("button", { name: "Close navigation" })).not.toBeVisible();
	await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
	await expectNoPageOverflow(page);
	await page.screenshot({
		path: ".impeccable/review/launcher-mobile.png",
		fullPage: true,
		animations: "disabled",
	});
});
