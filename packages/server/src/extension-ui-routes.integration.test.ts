import { buildExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import { createLoadedExtensionModuleForTest } from "@leitwerk-dev/extension-runtime/testing";
import {
	createIntegrationHarness,
	type IntegrationHarness,
} from "@leitwerk-dev/test-support/integration";
import { afterEach, describe, expect, it } from "vitest";
import {
	createTempExtensionUiPackage,
	createTestExtensionUiModule,
	type TempExtensionUiPackageFixture,
} from "../test-fixtures/extension-ui.js";

const fixtures: TempExtensionUiPackageFixture[] = [];
const harnesses: Array<IntegrationHarness<Record<string, never>>> = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.ctx.app.close();
	}
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

describe("extension UI renderer routes", () => {
	it("serves renderer descriptors and same-origin extension UI assets", async () => {
		const fixture = await createTempExtensionUiPackage({
			assetFiles: {
				"dist/ui/assets/leaf-outcome.js":
					"if (!customElements.get('o2-test-leaf-outcome')) { customElements.define('o2-test-leaf-outcome', class extends HTMLElement {}); }",
			},
		});
		fixtures.push(fixture);
		const extensionCatalog = await buildExtensionCatalog([
			createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
				packageName: "@leitwerk-dev/test-extension",
				packageDir: fixture.packageDir,
			}),
		]);
		const harness = await createIntegrationHarness({
			listen: false,
			extensionCatalog,
		});
		harnesses.push(harness);

		const descriptorResponse = await harness.ctx.app.inject({
			method: "GET",
			url: "/api/ui/renderers/test%3Aprocess.leaf_outcome",
		});
		expect(descriptorResponse.statusCode).toBe(200);
		expect(descriptorResponse.json()).toEqual({
			ok: true,
			rendererId: "test:process.leaf_outcome",
			kind: "custom_element",
			tagName: "o2-test-leaf-outcome",
			modulePath: "assets/leaf-outcome.js",
			rendererApiVersion: 1,
			extensionManifestId: "test-extension",
			moduleUrl: "/ext-ui/test-extension/assets/leaf-outcome.js",
		});

		const assetResponse = await harness.ctx.app.inject({
			method: "GET",
			url: "/ext-ui/test-extension/assets/leaf-outcome.js",
		});
		expect(assetResponse.statusCode).toBe(200);
		expect(assetResponse.headers["content-type"]).toContain("text/javascript");
		expect(assetResponse.body).toContain("o2-test-leaf-outcome");
	});

	it("serves extension UI sound assets with an audio content type", async () => {
		const fixture = await createTempExtensionUiPackage({
			assetFiles: {
				"dist/ui/assets/leaf-outcome.js": "export {};",
				"dist/ui/sounds/sample.ogg": "OggS",
			},
		});
		fixtures.push(fixture);
		const extensionCatalog = await buildExtensionCatalog([
			createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
				packageName: "@leitwerk-dev/test-extension",
				packageDir: fixture.packageDir,
			}),
		]);
		const harness = await createIntegrationHarness({
			listen: false,
			extensionCatalog,
		});
		harnesses.push(harness);

		const soundResponse = await harness.ctx.app.inject({
			method: "GET",
			url: "/ext-ui/test-extension/sounds/sample.ogg",
		});
		expect(soundResponse.statusCode).toBe(200);
		expect(soundResponse.headers["content-type"]).toContain("audio/ogg");
		expect(soundResponse.body).toBe("OggS");
	});

	it("serves browser extension module descriptors", async () => {
		const fixture = await createTempExtensionUiPackage({
			manifestContent: JSON.stringify(
				{
					apiVersion: 1,
					extensionManifestId: "test-extension",
					browserModules: [{ module: "assets/shell.js", browserApiVersion: 1 }],
				},
				null,
				2,
			),
			assetFiles: {
				"dist/ui/assets/shell.js": "export {};",
			},
		});
		fixtures.push(fixture);
		const extensionCatalog = await buildExtensionCatalog([
			createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
				packageName: "@leitwerk-dev/test-extension",
				packageDir: fixture.packageDir,
			}),
		]);
		const harness = await createIntegrationHarness({
			listen: false,
			extensionCatalog,
		});
		harnesses.push(harness);

		const response = await harness.ctx.app.inject({
			method: "GET",
			url: "/api/ui/extensions",
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			ok: true,
			extensions: [
				{
					extensionManifestId: "test-extension",
					modulePath: "assets/shell.js",
					browserApiVersion: 1,
					moduleUrl: "/ext-ui/test-extension/assets/shell.js",
				},
			],
		});
	});

	it("returns structured not-found responses and blocks traversal outside the asset root", async () => {
		const fixture = await createTempExtensionUiPackage();
		fixtures.push(fixture);
		const extensionCatalog = await buildExtensionCatalog([
			createLoadedExtensionModuleForTest(createTestExtensionUiModule(), {
				packageName: "@leitwerk-dev/test-extension",
				packageDir: fixture.packageDir,
			}),
		]);
		const harness = await createIntegrationHarness({
			listen: false,
			extensionCatalog,
		});
		harnesses.push(harness);

		const missingDescriptor = await harness.ctx.app.inject({
			method: "GET",
			url: "/api/ui/renderers/missing-renderer",
		});
		expect(missingDescriptor.statusCode).toBe(404);
		expect(missingDescriptor.json()).toEqual({
			ok: false,
			rendererId: "missing-renderer",
			code: "renderer_not_found",
			message: "Renderer is not available for any loaded extension UI bundle",
		});

		const traversalAttempt = await harness.ctx.app.inject({
			method: "GET",
			url: "/ext-ui/test-extension/../package.json",
		});
		expect(traversalAttempt.statusCode).toBe(404);
	});
});
