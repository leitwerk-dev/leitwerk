import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testWorkspace } from "../test-workspace.js";
import { buildExtensionBundle } from "./bundle.js";
import { runBundleCheckCli } from "./bundle-check.js";

async function fixture(options: { missingResource?: boolean; source?: string } = {}) {
	const { root, json } = testWorkspace();
	await mkdir(path.join(root, "extension", "dist"), { recursive: true });
	await symlink(path.resolve("node_modules"), path.join(root, "node_modules"));
	json("package.json", { name: "fixture", workspaces: [] });
	await writeFile(
		path.join(root, "config.yaml"),
		"storage: { sqlite_path: live.sqlite }\npi:\n  default_model_profile: test\n  model_profiles:\n    - { id: test, provider: test, model_id: test }\n",
	);
	json("extension/package.json", {
		name: "@example/path-extension",
		version: "1.0.0",
		type: "module",
		dependencies: { "@leitwerk-dev/test-support": "*" },
		files: ["dist/**"],
		leitwerk: {
			extension: { import: "./dist/index.js" },
			pi: { resources: { prompts: [options.missingResource ? "unpacked.txt" : "dist"] } },
		},
	});
	await writeFile(
		path.join(root, "extension", "dist", "index.js"),
		options.source ??
			`import { fixtureModelProviders } from '@leitwerk-dev/test-support';
export default { manifest: { id: 'x', version: '1' }, modelProviders: fixtureModelProviders({ id: 'test', modelId: 'test' }) };`,
	);
	await writeFile(path.join(root, "extension", "unpacked.txt"), "not published");
	const check = (output: string) =>
		runBundleCheckCli([output, "--config", path.join(root, "config.yaml")]);
	await writeFile(path.join(root, "live.sqlite"), "not a SQLite database");
	await writeFile(
		path.join(root, "composition.yaml"),
		"version: 1\nworkspace_root: .\nruntime_config: config.yaml\nextensions:\n  - ./extension\n",
	);
	return { root, check, composition: path.join(root, "composition.yaml") };
}

describe("extension bundles", () => {
	it("produces the same digest for equal inputs and preserves ordered provenance", async () => {
		const first = await fixture();
		const a = await buildExtensionBundle(first.composition, path.join(first.root, "one"));
		const b = await buildExtensionBundle(first.composition, path.join(first.root, "two"));
		expect(b.digest).toBe(a.digest);
		await first.check(path.join(first.root, "two"));
		expect(a.sources).toEqual([
			{ source: "extension", packageName: "@example/path-extension", path: "extension" },
		]);
	});

	it.each([
		["a missing import", "import 'not-in-the-bundle';", /not-in-the-bundle/],
		["invalid syntax", "export default { manifest: { id: 'x', version: }; };", /Unexpected token/],
	])("fails boot for %s", async (_label, source, error) => {
		const input = await fixture({ source });
		const output = path.join(input.root, "bundle");
		await buildExtensionBundle(input.composition, output);
		await expect(input.check(output)).rejects.toThrow(error);
	});

	it("rejects a declared resource that is not packaged", async () => {
		const input = await fixture({ missingResource: true });
		await expect(
			buildExtensionBundle(input.composition, path.join(input.root, "bundle")),
		).rejects.toThrow("declares missing resource 'unpacked.txt'");
	});
});
