import coding from "@leitwerk-dev/coding";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import showcase from "@leitwerk-dev/showcase-processes";
import { expect, expectNoPageOverflow, test } from "./fixtures.js";

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-settings-browser-",
		createExtensionCatalog: () => buildExtensionCatalogFromModules([coding, showcase]),
	},
});

test("instruction overrides inherit, compose, reset and preserve conflicting drafts", async ({
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
	const field = page.getByRole("region", { name: "Repository instructions", exact: true });
	await field.getByRole("button", { name: "Override", exact: true }).click();
	const input = field.getByLabel("Repository instructions override", { exact: true });
	await expect(input).toBeFocused();
	await input.fill("Installation instructions");
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.getByRole("status")).toContainText("Saved");
	await expect(field.getByRole("button", { name: "Edit override" })).toBeFocused();
	const scopeResponse = await page.request.get("/api/settings/scopes");
	const repository = (await scopeResponse.json()).subjects.find(
		(subject: { scopeType: string }) => subject.scopeType === "repository",
	);
	await page.getByLabel("Apply settings to").selectOption(repository.id);
	await expect(field).toContainText("Installation instructions");
	await field.getByRole("button", { name: "Override", exact: true }).click();
	await input.fill("Repository draft");
	await expect(field.locator(".combined")).toContainText(
		"Installation instructions\n\nRepository draft",
	);
	const external = await page.request.put("/api/settings/overrides", {
		data: {
			subjectId: repository.id,
			key: "coding.repository_instructions",
			value: "Another operator's change",
			mode: "append",
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
	await field.getByLabel("Instruction behavior").selectOption("replace");
	await input.fill("");
	await field.getByRole("button", { name: "Save override" }).click();
	await expect(field.locator(".effective p")).toHaveText("Empty");
	await field.getByRole("button", { name: "Use inherited value" }).click();
	await expect(field.locator(".effective p")).toHaveText("Installation instructions");
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
