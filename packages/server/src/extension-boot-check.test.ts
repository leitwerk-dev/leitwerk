import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultConfig } from "./config/index.js";
import { runExtensionBootCheck } from "./extension-boot-check.js";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("extension boot check", () => {
	it("loads a built extension and reaches readiness without configured storage", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "leitwerk-extension-boot-"));
		temporary.push(root);
		const extension = path.join(root, "extension");
		await mkdir(path.join(extension, "dist"), { recursive: true });
		await mkdir(path.join(root, "node_modules", "@leitwerk-dev"), { recursive: true });
		await symlink(
			path.resolve("packages/process-sdk"),
			path.join(root, "node_modules", "@leitwerk-dev/process-sdk"),
		);
		await writeFile(
			path.join(extension, "package.json"),
			JSON.stringify({
				name: "@example/boot-extension",
				version: "1.0.0",
				files: ["dist/**"],
				leitwerk: { extension: { import: "./dist/index.js" } },
			}),
		);
		await writeFile(
			path.join(extension, "dist", "index.js"),
			`import { builtinPiProvider, defineModelProvider, defineModelProviders } from "@leitwerk-dev/process-sdk";
const provider = defineModelProvider({ id: "boot-provider", parseConfig: () => ({ config: {} }), worker: builtinPiProvider("test"), models: () => [], secrets: () => ({}) });
export default { manifest: { id: "boot", version: "1" }, modelProviders: defineModelProviders(() => [{ definition: provider, rawConfig: {} }]) };\n`,
		);

		const config = getDefaultConfig();
		config.pi.default_model_profile = "test";
		config.pi.model_profiles = [{ id: "test", provider: "boot-provider", model_id: "test" }];
		await expect(
			runExtensionBootCheck({ config, extensionLoadingStartDir: root, sources: [extension] }),
		).resolves.toBeUndefined();
	});
});
