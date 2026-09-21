import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import providerComposition from "../../../sandbox/provider-composition.js";

it("registers public providers exactly once without private extensions", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "public-catalog-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	const composition = providerComposition({
		paths: { workspaceRoot: root, root, directory: root },
		mode: "scripted",
		urls: { backend: "http://127.0.0.1:18082", ui: "http://127.0.0.1:19173" },
		modelProfileId: "sandbox",
	});
	const catalog = await composition.createCatalog();
	const modules = catalog.modules.map(({ module }) => module.manifest.id);
	for (const id of ["forgejo", "github", "woodpecker", "ticket-creation"])
		expect(modules.filter((module) => module === id)).toHaveLength(1);
	expect(new Set(modules).size).toBe(modules.length);
	expect(modules).not.toContain("leitwerk-self-improvement");
});
