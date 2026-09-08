import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDevelopmentComposition } from "./development-composition.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("development composition", () => {
	it("uses the executing checkout with installed extension package names", () => {
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-installed-composition-"));
		tempDirs.push(root);
		const checkout = path.join(root, "core");
		const extension = path.join(root, "node_modules/@example/extension");
		mkdirSync(checkout, { recursive: true });
		mkdirSync(extension, { recursive: true });
		writeJson(path.join(root, "package.json"), { private: true, workspaces: [] });
		writeJson(path.join(extension, "package.json"), {
			name: "@example/extension",
			exports: { ".": "./dist/index.js" },
		});
		writeFileSync(path.join(root, "leitwerk.yaml"), "{}");
		const manifest = path.join(root, "composition.yaml");
		writeFileSync(
			manifest,
			'version: 1\nruntime_config: ./leitwerk.yaml\nextensions: ["@example/extension"]\n',
		);
		const composition = loadDevelopmentComposition(manifest, checkout);
		expect(composition.leitwerkRoot).toBe(realpathSync(checkout));
		expect(composition.extensionDirs).toEqual([realpathSync(extension)]);
		writeFileSync(
			manifest,
			'version: 1\nruntime_config: ./leitwerk.yaml\nextensions: ["@example/missing"]\n',
		);
		expect(() => loadDevelopmentComposition(manifest, checkout)).toThrow(/is not installed/);
	});

	it("resolves external workspace packages, extensions, config, and test roots", () => {
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-composition-"));
		tempDirs.push(root);
		const leitwerkRoot = path.join(root, "leitwerk");
		const privateRoot = path.join(root, "private");
		const extensionDir = path.join(privateRoot, "extensions", "foo");
		const packageDir = path.join(privateRoot, "packages", "bar");
		const testsDir = path.join(privateRoot, "tests");
		for (const dir of [leitwerkRoot, extensionDir, packageDir, testsDir]) {
			mkdirSync(dir, { recursive: true });
		}
		writeJson(path.join(leitwerkRoot, "package.json"), { name: "leitwerk", private: true });
		writeJson(path.join(privateRoot, "package.json"), {
			name: "private",
			private: true,
			workspaces: ["packages/*", "extensions/*", "../leitwerk/packages/*"],
		});
		writeJson(path.join(extensionDir, "package.json"), {
			name: "@private/foo",
			leitwerk: { extension: { source: "./src/index.ts", import: "./dist/index.js" } },
		});
		writeJson(path.join(packageDir, "package.json"), { name: "@private/bar" });
		writeFileSync(path.join(privateRoot, "leitwerk.yaml"), "extension_loading:\n  sources: []\n");
		writeFileSync(
			path.join(privateRoot, "leitwerk.composition.yaml"),
			[
				"version: 1",
				"leitwerk:",
				"  root: ../leitwerk",
				"workspace_root: .",
				"runtime_config: ./leitwerk.yaml",
				"extensions:",
				"  - ./extensions/foo",
				"test_roots:",
				"  - ./tests",
			].join("\n"),
		);

		const composition = loadDevelopmentComposition(
			path.join(privateRoot, "leitwerk.composition.yaml"),
			leitwerkRoot,
		);

		expect(composition.extensionDirs).toEqual([realpathSync(extensionDir)]);
		expect(composition.testRoots).toEqual([realpathSync(testsDir)]);
		expect(composition.externalPackages.map((entry) => entry.name)).toEqual([
			"@private/bar",
			"@private/foo",
		]);
	});

	it("rejects a composition targeting another Leitwerk checkout", () => {
		const root = mkdtempSync(path.join(tmpdir(), "leitwerk-composition-mismatch-"));
		tempDirs.push(root);
		for (const dir of ["leitwerk-a", "leitwerk-b", "private", "private/tests"]) {
			mkdirSync(path.join(root, dir), { recursive: true });
		}
		writeJson(path.join(root, "private", "package.json"), { private: true, workspaces: [] });
		writeFileSync(
			path.join(root, "private", "leitwerk.yaml"),
			"extension_loading:\n  sources: []\n",
		);
		writeFileSync(
			path.join(root, "private", "composition.yaml"),
			"version: 1\nleitwerk:\n  root: ../leitwerk-a\nruntime_config: ./leitwerk.yaml\n",
		);

		expect(() =>
			loadDevelopmentComposition(
				path.join(root, "private", "composition.yaml"),
				path.join(root, "leitwerk-b"),
			),
		).toThrow(/targets Leitwerk checkout/);
	});
});
