import path from "node:path";
import { createLoadedExtensionModuleForTest } from "@leitwerk-dev/extension-runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	createTempExtensionUiPackage,
	createTestExtensionUiModule,
	type TempExtensionUiPackageFixture,
} from "../../test-fixtures/extension-ui.js";
import { buildExtensionUiCatalog, resolveExtensionUiAssetPath } from "./catalog.js";

const fixtures: TempExtensionUiPackageFixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("buildExtensionUiCatalog", () => {
	it("discovers renderer descriptors from extension package metadata", async () => {
		const fixture = await createTempExtensionUiPackage();
		fixtures.push(fixture);
		const catalog = await buildExtensionUiCatalog([
			createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
				packageName: "@leitwerk-dev/test-extension",
				packageDir: fixture.packageDir,
			}),
		]);

		expect(catalog.getRenderer("test:process.leaf_outcome")).toEqual({
			rendererId: "test:process.leaf_outcome",
			kind: "custom_element",
			tagName: "o2-test-leaf-outcome",
			modulePath: "assets/leaf-outcome.js",
			rendererApiVersion: 1,
			extensionManifestId: "test-extension",
			moduleUrl: "/ext-ui/test-extension/assets/leaf-outcome.js",
		});
		expect(resolveExtensionUiAssetPath(catalog, "test-extension", "assets/leaf-outcome.js")).toBe(
			path.join(fixture.packageDir, "dist/ui/assets/leaf-outcome.js"),
		);
	});

	it("selects source UI manifests in the source runtime lane", async () => {
		const fixture = await createTempExtensionUiPackage({
			sourceManifestPath: "./src/ui/manifest.json",
			sourceManifestContent: JSON.stringify(
				{
					apiVersion: 1,
					extensionManifestId: "test-extension",
					browserModules: [{ module: "./shell.ts", browserApiVersion: 1 }],
				},
				null,
				2,
			),
			assetFiles: {
				"dist/ui/assets/leaf-outcome.js": "export {};",
				"src/ui/shell.ts": "export {};",
			},
		});
		fixtures.push(fixture);
		const catalog = await buildExtensionUiCatalog(
			[
				createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
					packageName: "@leitwerk-dev/test-extension",
					packageDir: fixture.packageDir,
				}),
			],
			{ runtimeLane: "source" },
		);

		expect(catalog.listBrowserModules()).toEqual([
			{
				extensionManifestId: "test-extension",
				modulePath: "shell.ts",
				browserApiVersion: 1,
				moduleUrl: "/ext-ui/test-extension/shell.ts",
			},
		]);
		expect(resolveExtensionUiAssetPath(catalog, "test-extension", "shell.ts")).toBe(
			path.join(fixture.packageDir, "src/ui/shell.ts"),
		);
	});

	it("discovers browser modules from extension UI manifests", async () => {
		const fixture = await createTempExtensionUiPackage({
			manifestContent: JSON.stringify(
				{
					apiVersion: 1,
					extensionManifestId: "test-extension",
					browserModules: [{ module: "./assets/shell.js", browserApiVersion: 1 }],
				},
				null,
				2,
			),
			assetFiles: {
				"dist/ui/assets/shell.js": "export {};",
			},
		});
		fixtures.push(fixture);
		const catalog = await buildExtensionUiCatalog([
			createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
				packageName: "@leitwerk-dev/test-extension",
				packageDir: fixture.packageDir,
			}),
		]);

		expect(catalog.listBrowserModules()).toEqual([
			{
				extensionManifestId: "test-extension",
				modulePath: "assets/shell.js",
				browserApiVersion: 1,
				moduleUrl: "/ext-ui/test-extension/assets/shell.js",
			},
		]);
	});

	it("rejects duplicate renderer ids across loaded extension UI manifests", async () => {
		const firstFixture = await createTempExtensionUiPackage();
		const secondFixture = await createTempExtensionUiPackage({
			manifestContent: JSON.stringify(
				{
					apiVersion: 1,
					extensionManifestId: "test-extension-2",
					renderers: {
						"test:process.leaf_outcome": {
							kind: "custom_element",
							tagName: "o2-test-leaf-outcome-two",
							module: "./assets/leaf-outcome.js",
							rendererApiVersion: 1,
						},
					},
				},
				null,
				2,
			),
		});
		fixtures.push(firstFixture, secondFixture);

		await expect(
			buildExtensionUiCatalog([
				createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
					packageName: "@leitwerk-dev/test-extension-a",
					packageDir: firstFixture.packageDir,
				}),
				createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
					packageName: "@leitwerk-dev/test-extension-b",
					packageDir: secondFixture.packageDir,
				}),
			]),
		).rejects.toThrow("Duplicate extension UI rendererId 'test:process.leaf_outcome'");
	});

	it("rejects traversal in manifest metadata and in served asset paths", async () => {
		const invalidFixture = await createTempExtensionUiPackage({
			manifestContent: JSON.stringify(
				{
					apiVersion: 1,
					extensionManifestId: "test-extension",
					renderers: {
						"test:process.leaf_outcome": {
							kind: "custom_element",
							tagName: "o2-test-leaf-outcome",
							module: "../escape.js",
							rendererApiVersion: 1,
						},
					},
				},
				null,
				2,
			),
			assetFiles: {
				"dist/escape.js": "export {};",
			},
		});
		fixtures.push(invalidFixture);

		await expect(
			buildExtensionUiCatalog([
				createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
					packageName: "@leitwerk-dev/test-extension",
					packageDir: invalidFixture.packageDir,
				}),
			]),
		).rejects.toThrow("must stay within the declared asset root");

		const validFixture = await createTempExtensionUiPackage();
		fixtures.push(validFixture);
		const catalog = await buildExtensionUiCatalog([
			createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
				packageName: "@leitwerk-dev/test-extension",
				packageDir: validFixture.packageDir,
			}),
		]);
		expect(resolveExtensionUiAssetPath(catalog, "test-extension", "../escape.js")).toBeNull();
	});
});
