import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LeitwerkExtensionModule } from "@leitwerk-dev/process-sdk";

export interface TempExtensionUiPackageOptions {
	manifestPath?: string;
	manifestContent?: string;
	sourceManifestPath?: string;
	sourceManifestContent?: string;
	assetFiles?: Record<string, string>;
}

export interface TempExtensionUiPackageFixture {
	packageDir: string;
	cleanup(): Promise<void>;
}

export async function createTempExtensionUiPackage(
	options: TempExtensionUiPackageOptions = {},
): Promise<TempExtensionUiPackageFixture> {
	const packageDir = await mkdtemp(path.join(os.tmpdir(), "o2-ext-ui-"));
	const manifestPath = options.manifestPath ?? "./dist/ui/manifest.json";
	const sourceManifestPath = options.sourceManifestPath ?? manifestPath;
	const manifestContent =
		options.manifestContent ??
		JSON.stringify(
			{
				apiVersion: 1,
				extensionManifestId: "test-extension",
				renderers: {
					"test:process.leaf_outcome": {
						kind: "custom_element",
						tagName: "o2-test-leaf-outcome",
						module: "./assets/leaf-outcome.js",
						rendererApiVersion: 1,
					},
				},
			},
			null,
			2,
		);
	await writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify(
			{
				name: "@leitwerk-dev/test-extension",
				private: true,
				type: "module",
				leitwerk: {
					extension: {
						source: "./src/index.ts",
						import: "./src/index.ts",
					},
					ui: {
						source: sourceManifestPath,
						import: manifestPath,
					},
				},
			},
			null,
			2,
		),
	);
	await mkdir(path.dirname(path.join(packageDir, manifestPath)), { recursive: true });
	await writeFile(path.join(packageDir, manifestPath), manifestContent);
	if (sourceManifestPath !== manifestPath) {
		await mkdir(path.dirname(path.join(packageDir, sourceManifestPath)), { recursive: true });
		await writeFile(
			path.join(packageDir, sourceManifestPath),
			options.sourceManifestContent ?? manifestContent,
		);
	}
	for (const [relativePath, content] of Object.entries(
		options.assetFiles ?? {
			"dist/ui/assets/leaf-outcome.js": "export {};",
		},
	)) {
		const assetPath = path.join(packageDir, relativePath);
		await mkdir(path.dirname(assetPath), { recursive: true });
		await writeFile(assetPath, content);
	}
	return {
		packageDir,
		async cleanup() {
			await rm(packageDir, { recursive: true, force: true });
		},
	};
}

export function createTestExtensionUiModule(): LeitwerkExtensionModule {
	return {
		manifest: {
			id: "test-extension",
			version: "0.1.0",
		},
	};
}
