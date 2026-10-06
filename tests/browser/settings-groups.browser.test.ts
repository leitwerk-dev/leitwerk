import coding from "@leitwerk-dev/coding";
import { SYSTEM_ACTOR } from "@leitwerk-dev/domain";
import { buildExtensionCatalogFromModules } from "@leitwerk-dev/extension-runtime/testing";
import jira from "@leitwerk-dev/jira";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";
import { expect, expectNoPageOverflow, test } from "./fixtures.js";

const componentSettings: LeitwerkExtensionModule = {
	manifest: { id: "component-settings", version: "1" },
	scopedSettings: {
		settings: [
			{
				key: "component-settings.instructions",
				schemaVersion: 1,
				scopes: ["jira.component"],
				merge: "replace",
				defaultValue: "",
				schema: {
					parse(value) {
						if (typeof value !== "string") throw new Error("Expected instructions");
						return value;
					},
				},
				form: { label: "Component instructions", control: "textarea", group: "Instructions" },
			},
		],
	},
};

test.use({
	browserServerOptions: {
		tempPrefix: "leitwerk-settings-groups-",
		createExtensionCatalog: () =>
			buildExtensionCatalogFromModules([
				coding,
				{ manifest: jira.manifest, scopedSettings: jira.scopedSettings },
				componentSettings,
			]),
	},
});

test("scope tabs separate similar labels and retain selection, drafts and inactive scopes", async ({
	page,
	leitwerk,
}) => {
	const settings = leitwerk.ctx.deps.scopedSettingsService;
	if (!settings) throw new Error("Missing settings service");
	await page.goto("/settings");
	await expect(page.getByRole("tab")).toHaveText(["Instance"]);
	const label = "ATLAS / Customer experience";
	const repository = settings.discover({
		scopeType: "repository",
		identity: "repository-1",
		label,
	});
	const project = settings.discover({
		scopeType: "jira.project",
		identity: "project-1",
		label: "ATLAS",
	});
	const component = settings.discover({
		scopeType: "jira.component",
		identity: "component-1",
		label,
	});
	settings.discover({ scopeType: "jira.component", identity: "component-2", label: "ATLAS / API" });
	const inactive = leitwerk.ctx.deps.transaction((tx) =>
		tx.scopedSettings.putSubject({
			scopeType: "removed.component",
			identity: "retained",
			label: "Retained component",
			context: {},
		}),
	);
	leitwerk.ctx.deps.transaction((tx) =>
		tx.scopedSettings.write({
			subjectId: inactive.id,
			key: "removed.instructions",
			value: "Retained instructions",
			mode: "replace",
			reset: false,
			schemaVersion: 1,
			expectedRevision: 0,
			actor: SYSTEM_ACTOR,
		}),
	);

	await page.goto(`/settings?scope=${component.id}`);
	const components = page.getByRole("tab", { name: "Jira components", exact: true });
	const repositories = page.getByRole("tab", { name: "Repositories", exact: true });
	const instance = page.getByRole("tab", { name: "Instance", exact: true });
	const select = page.getByLabel("Apply settings to");
	await expect(page.getByRole("tab")).toHaveText([
		"Instance",
		"Repositories",
		"Jira components",
		"removed.component (inactive)",
	]);
	await expect(components).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("tabpanel", { name: "Jira components" })).toBeVisible();
	await expect(select).toHaveValue(component.id);
	await expect(select.locator("option")).toHaveText(["ATLAS / API", label]);
	await expect(select.locator(`option[value="${repository.id}"]`)).toHaveCount(0);

	// Arrow keys explore tabs; Enter activates without loading every intermediate group.
	await components.focus();
	await page.keyboard.press("Home");
	await expect(instance).toBeFocused();
	await expect(components).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("ArrowRight");
	await expect(repositories).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(repositories).toHaveAttribute("aria-selected", "true");
	await expect(select).toHaveValue(repository.id);
	await expect(select.locator("option")).toHaveText([label]);
	const field = page.getByRole("region", { name: "Repository instructions", exact: true });
	await field.getByRole("button", { name: "Override", exact: true }).click();
	const input = field.getByLabel("Repository instructions override", { exact: true });
	await input.fill("Keep this unsaved draft across source refresh");
	settings.discover({
		scopeType: "repository",
		identity: repository.identity,
		label: "ATLAS / Renamed",
	});
	settings.discover({ scopeType: "repository", identity: "repository-2", label: "ATLAS / API" });
	await page.getByRole("button", { name: "Refresh sources" }).click();
	await expect(select.locator("option")).toHaveText(["ATLAS / API", "ATLAS / Renamed"]);
	await expect(select).toHaveValue(repository.id);
	await expect(input).toHaveValue("Keep this unsaved draft across source refresh");
	await expect(repositories).toHaveAttribute("aria-selected", "true");
	await field.getByRole("button", { name: "Cancel", exact: true }).click();
	await components.click();
	await expect(select).toHaveValue(component.id);
	await repositories.click();
	await expect(select).toHaveValue(repository.id);

	await page.getByRole("tab", { name: "removed.component (inactive)", exact: true }).click();
	await expect(select).toHaveValue(inactive.id);
	await expect(page.getByText("Retained instructions", { exact: true })).toBeVisible();
	await expect(select.locator("option")).toHaveText(["Retained component (inactive)"]);
	await page.goto(`/settings?scope=${inactive.id}`);
	await expect(page.getByRole("tab", { name: "removed.component (inactive)" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await expect(select).toHaveValue(inactive.id);
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoPageOverflow(page);
	await components.focus();
	await page.keyboard.press("End");
	await expect(page.getByRole("tab", { name: "removed.component (inactive)" })).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(instance).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(page.getByRole("tab", { name: "removed.component (inactive)" })).toBeFocused();
	await components.click();
	await expect(select.locator("option")).toHaveText(["ATLAS / API", label]);
	await expectNoPageOverflow(page);

	// Discovery-only scopes stay out of navigation, while existing direct links still resolve.
	await expect(page.getByRole("tab", { name: "Jira projects", exact: true })).toHaveCount(0);
	await page.goto(`/settings?scope=${project.id}`);
	await expect(
		page.getByText("No installed extension declares settings for this scope."),
	).toBeVisible();
	await instance.click();
	await expect(page.getByRole("tab", { name: "Jira projects", exact: true })).toHaveCount(0);
});
