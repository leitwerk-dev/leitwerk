import coding from "@leitwerk-dev/coding";
import examples from "@leitwerk-dev/example-processes";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import showcase from "@leitwerk-dev/showcase-processes";
import { expect, expectNoPageOverflow, test } from "./fixtures.js";

const reportSettings: LeitwerkExtensionModule = {
	manifest: { id: "settings-browser", version: "1" },
	scopedSettings: {
		settings: [
			{
				key: "settings-browser.report_title",
				schemaVersion: 1,
				scopes: ["instance", "repository"],
				merge: "replace",
				defaultValue: "",
				schema: {
					parse(value) {
						if (typeof value !== "string") throw new Error("Expected report title");
						return value;
					},
				},
				form: { label: "Report title", group: "Reports", control: "textarea" },
			},
		],
	},
};

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-settings-browser-",
		createExtensionCatalog: () =>
			buildExtensionCatalogFromModules([coding, examples, showcase, reportSettings]),
	},
});

test("repository instructions cannot be configured", async ({ page, leitwerk: _leitwerk }) => {
	await page.goto("/settings");
	await expect(page.getByRole("region", { name: "Planning model", exact: true })).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Repository instructions", exact: true }),
	).toHaveCount(0);
	const rejected = await page.request.put("/api/settings/overrides", {
		data: {
			subjectId: "instance",
			key: "coding.repository_instructions",
			value: "Hidden instruction",
			expectedRevision: 0,
		},
	});
	expect(rejected.status()).toBe(409);
});

test("repository consolidation retains an open draft and checks its old revision", async ({
	page,
	leitwerk,
}) => {
	const settings = leitwerk.ctx.deps.scopedSettingsService;
	if (!settings) throw new Error("Missing settings service");
	const aliases = ["git@example.org:team/repo.git", "https://example.org/team/repo.git"];
	const provider = settings.discover({
		scopeType: "repository",
		identity: 'provider:["https://example.org","42"]',
		label: "team/repo",
	});
	const subjects = aliases.map((alias) =>
		settings.discover({
			scopeType: "repository",
			identity: `locator:${alias}`,
			label: alias,
			aliases: [alias],
		}),
	);
	for (const subject of subjects) {
		const saved = await page.request.put("/api/settings/overrides", {
			data: {
				subjectId: subject.id,
				key: "settings-browser.report_title",
				value: "Shared guidance",
				mode: "replace",
				expectedRevision: 0,
			},
		});
		expect(saved.ok()).toBe(true);
	}
	await page.goto(`/settings?scope=${subjects[1].id}`);
	const field = page.getByRole("region", { name: "Report title", exact: true });
	await field.getByRole("button", { name: "Edit override" }).click();
	const input = field.getByLabel("Report title override", { exact: true });
	await input.fill("Draft retained after repository merge");
	expect(
		settings.discover({
			scopeType: "repository",
			identity: provider.identity,
			label: provider.label,
			aliases,
		}).id,
	).toBe(provider.id);
	await page.request.post("/api/settings/scopes/refresh");
	await expect(input).toHaveValue("Draft retained after repository merge");
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.getByRole("alert")).toContainText("changed since");
	await expect(input).toHaveValue("Draft retained after repository merge");
	await field.getByRole("button", { name: "Keep draft and use latest revision" }).click();
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.getByRole("status")).toContainText("Saved");
	const preview = await page.request.get(`/api/settings/preview?subjectId=${subjects[0].id}`);
	expect(
		(await preview.json()).fields.find(
			(entry: { key: string }) => entry.key === "settings-browser.report_title",
		).effective.value,
	).toBe("Draft retained after repository merge");
});

test("settings overrides inherit, replace, reset and preserve conflicting drafts", async ({
	page,
	leitwerk,
}) => {
	const process = leitwerk.ctx.deps.processes.create({
		processId: "settings_browser",
		title: "Repository settings",
	});
	leitwerk.ctx.deps.projects.create({
		instanceId: process.id,
		key: "private",
		repoLocator: "/workspace/browser-settings",
		baseBranch: "main",
	});
	await page.goto("/settings");
	const field = page.getByRole("region", { name: "Report title", exact: true });
	await field.getByRole("button", { name: "Override", exact: true }).click();
	const input = field.getByLabel("Report title override", { exact: true });
	await expect(input).toBeFocused();
	await input.fill("Installation report");
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.getByRole("status")).toContainText("Saved");
	await expect(field.getByRole("button", { name: "Edit override" })).toBeFocused();
	const scopeResponse = await page.request.get("/api/settings/scopes");
	const repository = (await scopeResponse.json()).subjects.find(
		(subject: { identity: string }) => subject.identity === "locator:/workspace/browser-settings",
	);
	await page.getByRole("tab", { name: "Repositories", exact: true }).click();
	await page.getByRole("button", { name: repository.label, exact: true }).click();
	await expect(field).toContainText("Installation report");
	await field.getByRole("button", { name: "Override", exact: true }).click();
	await input.fill("Repository draft");
	const external = await page.request.put("/api/settings/overrides", {
		data: {
			subjectId: repository.id,
			key: "settings-browser.report_title",
			value: "Another operator's change",
			mode: "replace",
			expectedRevision: 0,
		},
	});
	expect(external.ok()).toBe(true);
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.getByRole("alert")).toContainText("changed since");
	await expect(input).toHaveValue("Repository draft");
	await field.getByRole("button", { name: "Keep draft and use latest revision" }).click();
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.getByRole("status")).toContainText("Saved");
	await field.getByRole("button", { name: "Edit override" }).click();
	await input.fill("");
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.locator(".effective p")).toHaveText("Empty");
	await field.getByRole("button", { name: "Use inherited value" }).click();
	await expect(field.locator(".effective p")).toHaveText("Installation report");
	await expect(field.getByRole("status")).toContainText("Inherited value restored");
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoPageOverflow(page);
});

test("primary repository binding keeps a draft across concurrent edits and announces saving", async ({
	page,
	leitwerk,
}) => {
	const process = leitwerk.ctx.deps.processes.create({
		processId: "single_prompt_process",
		title: "Primary settings repository",
		lifecycleStatus: "completed",
	});
	for (const key of ["public", "private"])
		leitwerk.ctx.deps.projects.create({
			instanceId: process.id,
			key,
			repoLocator: `/workspace/primary-${key}`,
			baseBranch: "main",
		});
	await page.goto(`/processes/${process.id}?inspect=process&section=inputs`);
	const section = page.locator(".process-settings");
	await expect(section).toContainText("No primary repository is bound");
	const select = section.getByLabel("Primary repository for model defaults");
	await select.selectOption("private");
	const external = await page.request.put(
		`/api/settings/processes/${process.id}/primary-repository`,
		{
			data: { primaryRepositoryKey: "public", expectedPrimaryRepositoryKey: null },
		},
	);
	expect(external.ok()).toBe(true);
	await section.getByRole("button", { name: "Save primary repository" }).click();
	await expect(section.getByRole("alert")).toContainText("Primary repository changed");
	await expect(select).toHaveValue("private");
	await expect(section).toContainText("Current saved primary repository: public");
	await section.getByRole("button", { name: "Keep selection and use latest binding" }).click();
	await section.getByRole("button", { name: "Save primary repository" }).click();
	await expect(section.getByRole("status")).toContainText("Primary repository saved");
	const saved = await page.request.get(`/api/settings/processes/${process.id}`);
	expect((await saved.json()).primaryRepositoryKey).toBe("private");
	await expect(section.getByRole("link", { name: "private settings" })).toHaveAttribute(
		"href",
		/\/settings\?scope=/,
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoPageOverflow(page);
});
