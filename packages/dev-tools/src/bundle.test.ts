import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExtensionBundle } from "./bundle.js";
import { checkExtensionBundle } from "./bundle-check.js";

const temporary: string[] = [];
async function fixture(options: { missingResource?: boolean; source?: string } = {}) {
	const missingResource = options.missingResource ?? false;
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-bundle-test-"));
	temporary.push(root);
	await mkdir(path.join(root, "extension", "dist"), { recursive: true });
	await writeFile(
		path.join(root, "package.json"),
		JSON.stringify({ name: "fixture", workspaces: [] }),
	);
	await writeFile(
		path.join(root, "config.yaml"),
		"pi:\n  default_model_profile: test\n  model_profiles:\n    - id: test\n      provider: test\n      model_id: test\nextension_loading:\n  sources: []\n",
	);
	await writeFile(
		path.join(root, "extension", "package.json"),
		JSON.stringify({
			name: "@example/path-extension",
			version: "1.0.0",
			files: ["dist/**"],
			leitwerk: {
				extension: { import: "./dist/index.js" },
				pi: { resources: { prompts: [missingResource ? "missing" : "dist"] } },
			},
		}),
	);
	await writeFile(
		path.join(root, "extension", "dist", "index.js"),
		options.source ?? "export default { manifest: { id: 'x', version: '1' } };\n",
	);
	await writeFile(
		path.join(root, "composition.yaml"),
		"version: 1\nworkspace_root: .\nruntime_config: config.yaml\nextensions:\n  - ./extension\n",
	);
	return { root, composition: path.join(root, "composition.yaml") };
}

afterEach(async () => {
	await Promise.all(
		temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("extension bundles", () => {
	it("produces the same digest for equal inputs and preserves ordered provenance", async () => {
		const first = await fixture();
		const a = await buildExtensionBundle(first.composition, path.join(first.root, "one"));
		const b = await buildExtensionBundle(first.composition, path.join(first.root, "two"));
		expect(b.digest).toBe(a.digest);
		expect(a.sources).toEqual([
			{ source: "extension", packageName: "@example/path-extension", path: "extension" },
		]);
	});

	it("rejects an undeclared bare dependency in the packed JavaScript", async () => {
		const input = await fixture({
			source:
				"import missing from 'not-in-the-bundle'; export default { manifest: { id: 'x', version: missing } };\n",
		});
		const output = path.join(input.root, "bundle");
		await buildExtensionBundle(input.composition, output);
		await expect(checkExtensionBundle(output)).rejects.toThrow(
			"imports undeclared package 'not-in-the-bundle'",
		);
	});

	it("fails boot when a packed extension cannot load", async () => {
		const input = await fixture({
			source: "export default { manifest: { id: 'x', version: }; };\n",
		});
		const output = path.join(input.root, "bundle");
		await buildExtensionBundle(input.composition, output);
		await expect(checkExtensionBundle(output)).rejects.toThrow();
	});

	it("rejects a declared resource that is not packaged", async () => {
		const input = await fixture({ missingResource: true });
		await expect(
			buildExtensionBundle(input.composition, path.join(input.root, "bundle")),
		).rejects.toThrow("declares missing resource 'missing'");
	});
});
