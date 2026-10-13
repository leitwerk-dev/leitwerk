import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import { afterEach, expect, it, vi } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

afterEach(() => vi.unstubAllEnvs());

it.each(["source", "dist"])("contributes plain skills through the %s entrypoint", async (lane) => {
	vi.stubEnv("LEITWERK_RUNTIME_LANE", lane);
	const catalog = await loadExtensionCatalog({ sources: [packageRoot] });

	expect(catalog.modules.map(({ module }) => module.manifest.id)).toEqual(["skills"]);
	expect(catalog.processes.size).toBe(0);
	expect(catalog.modelProviders).toEqual([]);
	expect(catalog.piContributions).toEqual([
		{
			ownerExtensionId: "skills",
			packageName: "@leitwerk-dev/skills",
			resources: {
				skillDirectories: [path.join(packageRoot, "skills")],
				promptDirectories: [],
			},
		},
	]);
	await access(path.join(packageRoot, "skills/doc-writing/SKILL.md"));
});
