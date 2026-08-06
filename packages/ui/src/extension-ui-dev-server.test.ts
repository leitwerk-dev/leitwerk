import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	parseExtensionUiDevSources,
	resolveExtensionUiDevRequest,
} from "./extension-ui-dev-server.js";

describe("extension UI development source routing", () => {
	it("parses configured source roots and rejects duplicate manifest ids", () => {
		expect(
			parseExtensionUiDevSources(
				JSON.stringify([
					{
						extensionManifestId: "example",
						assetRootDir: "extensions/example/src/ui",
						packageRootDir: "extensions/example",
					},
				]),
			),
		).toEqual([
			{
				extensionManifestId: "example",
				assetRootDir: path.resolve("extensions/example/src/ui"),
				packageRootDir: path.resolve("extensions/example"),
			},
		]);
		expect(() =>
			parseExtensionUiDevSources(
				JSON.stringify([
					{
						extensionManifestId: "example",
						assetRootDir: "/tmp/one/src/ui",
						packageRootDir: "/tmp/one",
					},
					{
						extensionManifestId: "example",
						assetRootDir: "/tmp/two/src/ui",
						packageRootDir: "/tmp/two",
					},
				]),
			),
		).toThrow(/duplicate id 'example'/i);
	});

	it("maps extension asset URLs to source files and preserves the query", () => {
		const root = path.resolve("/tmp/example-ui");
		expect(
			resolveExtensionUiDevRequest("/ext-ui/example/renderers/result.ts?import", [
				{ extensionManifestId: "example", assetRootDir: root, packageRootDir: "/tmp/example" },
			]),
		).toEqual({
			filePath: path.join(root, "renderers/result.ts"),
			search: "?import",
		});
	});

	it("rejects unknown extensions, malformed escapes, and traversal", () => {
		const sources = [
			{
				extensionManifestId: "example",
				assetRootDir: "/tmp/example-ui",
				packageRootDir: "/tmp/example",
			},
		];
		expect(resolveExtensionUiDevRequest("/ext-ui/other/result.ts", sources)).toBeNull();
		expect(resolveExtensionUiDevRequest("/ext-ui/example/%zz", sources)).toBeNull();
		expect(resolveExtensionUiDevRequest("/ext-ui/example/%2e%2e/secret.ts", sources)).toBeNull();
	});
});
