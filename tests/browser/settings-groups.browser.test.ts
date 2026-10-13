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
				key: "component-settings.report_title",
				schemaVersion: 1,
				scopes: ["instance", "repository", "jira.component"],
				merge: "replace",
				defaultValue: "",
				schema: {
					parse(value) {
						if (typeof value !== "string") throw new Error("Expected report title");
						return value;
					},
				},
				form: { label: "Component report title", control: "textarea", group: "Reports" },
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
	const apiComponent = settings.discover({
		scopeType: "jira.component",
		identity: "component-2",
		label: "ATLAS / API",
	});
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
			key: "removed.report_title",
			value: "Retained report title",
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
	const row = (name: string) => page.getByRole("button", { name, exact: true });
	const selectedHeading = page.locator("#settings-editor-heading");
	const table = page.getByRole("table");
	await expect(page.getByRole("tab")).toHaveText([
		"Instance",
		"Repositories",
		"Jira components",
		"removed.component (inactive)",
	]);
	await expect(components).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("tabpanel", { name: "Jira components" })).toBeVisible();
	await expect(selectedHeading).toHaveText("Customer experience");
	await expect(table.getByRole("row")).toHaveCount(3);
	await expect(table.getByRole("button", { name: label, exact: true })).toHaveCount(0);
	await row("API").click();
	await expect(page).toHaveURL(`/settings?scope=${apiComponent.id}`);
	await page.reload();
	await expect(components).toHaveAttribute("aria-selected", "true");
	await expect(selectedHeading).toHaveText("API");
	await page.goBack();
	await expect(selectedHeading).toHaveText("Customer experience");
	await page.goForward();
	await expect(selectedHeading).toHaveText("API");
	await row("Customer experience").click();
	await expect(page).toHaveURL(`/settings?scope=${component.id}`);
	const historyLength = await page.evaluate(() => history.length);
	await components.click();
	expect(await page.evaluate(() => history.length)).toBe(historyLength);

	// Arrow keys explore tabs; Enter activates without loading every intermediate group.
	await components.focus();
	await page.keyboard.press("Home");
	await expect(instance).toBeFocused();
	await expect(components).toHaveAttribute("aria-selected", "true");
	await page.keyboard.press("ArrowRight");
	await expect(repositories).toBeFocused();
	await expect(page).toHaveURL(`/settings?scope=${component.id}`);
	await page.keyboard.press("Enter");
	await expect(page).toHaveURL(`/settings?scope=${repository.id}&view=overview`);
	await expect(repositories).toHaveAttribute("aria-selected", "true");
	await page.goBack();
	await expect(components).toHaveAttribute("aria-selected", "true");
	await expect(selectedHeading).toHaveText("Customer experience");
	await page.goForward();
	await expect(repositories).toHaveAttribute("aria-selected", "true");
	await row(label).click();
	await expect(selectedHeading).toHaveText(label);
	await expect(table.getByRole("row")).toHaveCount(2);
	const field = page.getByRole("region", { name: "Component report title", exact: true });
	await field.getByRole("button", { name: "Override", exact: true }).click();
	const input = field.getByLabel("Component report title override", { exact: true });
	await input.fill("Keep this unsaved draft across source refresh");
	settings.discover({
		scopeType: "repository",
		identity: repository.identity,
		label: "ATLAS / Renamed",
	});
	settings.discover({ scopeType: "repository", identity: "repository-2", label: "ATLAS / API" });
	await page.getByRole("button", { name: "Refresh sources" }).click();
	await expect(row("ATLAS / API")).toBeVisible();
	await expect(row("ATLAS / Renamed")).toBeVisible();
	await expect(selectedHeading).toHaveText(/Customer experience|Renamed/);
	await expect(input).toHaveValue("Keep this unsaved draft across source refresh");
	await expect(page).toHaveURL(`/settings?scope=${repository.id}`);
	await expect(repositories).toHaveAttribute("aria-selected", "true");
	await field.getByRole("button", { name: "Cancel", exact: true }).click();
	await components.click();
	await row("Customer experience").click();
	await expect(selectedHeading).toHaveText("Customer experience");
	await repositories.click();
	await row("ATLAS / Renamed").click();
	await expect(selectedHeading).toHaveText("ATLAS / Renamed");

	await page.getByRole("tab", { name: "removed.component (inactive)", exact: true }).click();
	await row("Retained component").click();
	await expect(selectedHeading).toHaveText("Retained component");
	await expect(page).toHaveURL(`/settings?scope=${inactive.id}`);
	await expect(page.getByText("Retained report title", { exact: true })).toBeVisible();
	await expect(table).toContainText("Inactive scope");
	await page.goto(`/settings?scope=${inactive.id}`);
	await expect(page.getByRole("tab", { name: "removed.component (inactive)" })).toHaveAttribute(
		"aria-selected",
		"true",
	);
	await row("Retained component").click();
	await expect(selectedHeading).toHaveText("Retained component");
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoPageOverflow(page);
	await expect(page.getByRole("complementary", { name: "Settings editor" })).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(row("Retained component")).toBeFocused();
	await expect(table).toBeVisible();
	await components.focus();
	await page.keyboard.press("End");
	await expect(page.getByRole("tab", { name: "removed.component (inactive)" })).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(instance).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(page.getByRole("tab", { name: "removed.component (inactive)" })).toBeFocused();
	await components.click();
	await expect(table.getByRole("row")).toHaveCount(3);
	await expectNoPageOverflow(page);

	// Discovery-only scopes stay out of navigation, while existing direct links still resolve.
	await expect(page.getByRole("tab", { name: "Jira projects", exact: true })).toHaveCount(0);
	await page.goto(`/settings?scope=${project.id}`);
	await expect(
		page.getByText("No installed extension declares settings for this scope."),
	).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await instance.click();
	await expect(page).toHaveURL("/settings?scope=instance");
	await expect(page.getByRole("tab", { name: "Jira projects", exact: true })).toHaveCount(0);
});
