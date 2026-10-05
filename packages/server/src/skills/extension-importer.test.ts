import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoadedExtensionModule } from "@leitwerk-dev/extension-runtime";
import { verifyCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { describe, expect, it, onTestFinished } from "vitest";
import { closeDatabase, createDatabase } from "../db/database.js";
import { createAllRepos } from "../db/repositories.js";
import { importExtensionSkills } from "./extension-importer.js";

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "extension-skill-test-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	const manifest = {
		formatVersion: 1,
		upstream: { url: "https://example.test/skills", commit: "a".repeat(40) },
		patchDigest: "b".repeat(64),
		skills: [
			{
				id: "review",
				directory: "review",
				label: "Review",
				description: "Review code",
				sourcePath: "skills/review",
				dependencies: ["design"],
			},
			{
				id: "design",
				directory: "design",
				label: "Design",
				description: "Design code",
				sourcePath: "skills/design",
				dependencies: [],
			},
		],
	};
	for (const skill of manifest.skills) {
		await mkdir(path.join(root, "dist/skills", skill.id), { recursive: true });
		await writeFile(
			path.join(root, "dist/skills", skill.id, "SKILL.md"),
			`---\nname: ${skill.id}\ndescription: ${skill.description}\n---\nRead the code.\n`,
		);
	}
	const skillPackPath = path.join(root, "dist/skills/manifest.json");
	await writeFile(skillPackPath, JSON.stringify(manifest));
	const loaded: LoadedExtensionModule = {
		packageName: "@test/skills",
		packageDir: root,
		entryPath: path.join(root, "index.js"),
		skillPackPath,
		module: { manifest: { id: "test-skills", version: "1.0.0" } },
	};
	return { root, loaded, manifest, skillPackPath };
}

describe("extension-owned skills", () => {
	it("pins dependencies and retains bundles across upgrade, removal, and database reopen", async () => {
		const f = await fixture();
		const sqlitePath = path.join(f.root, "database.sqlite");
		let db = createDatabase({ sqlitePath });
		onTestFinished(() => closeDatabase(db));
		let repos = createAllRepos(db);
		const first = await importExtensionSkills([f.loaded]);
		repos.transaction((tx) => tx.skills.reconcileExtensions(first));
		repos.skills.backfillDependencies();
		const selected = repos.skills.resolveActive(["review"]);
		expect(selected.map((skill) => skill.skillId)).toEqual(["design", "review"]);
		const process = repos.processes.create({ processId: "review_process" });
		repos.processSkills.attach(process.id, selected);
		const pinned = repos.processSkills.listResourceLayers(process.id);
		expect(pinned[1].owner.ownerExtensionId).toBe("test-skills");
		expect(repos.skills.getInstalledDetail("review")).toMatchObject({
			ownerExtensionId: "test-skills",
			registrationKind: "extension",
			provenance: { packageName: "@test/skills", dependencies: ["design"] },
		});
		repos.transaction((tx) => tx.skills.reconcileExtensions(first));
		expect(repos.skills.resolveActive(["review"])).toEqual(selected);

		const skillPath = path.join(f.root, "dist/skills/review/SKILL.md");
		await writeFile(skillPath, `${await readFile(skillPath, "utf8")}Updated instructions.\n`);
		repos.transaction((tx) => tx.skills.reconcileExtensions(first));
		const updated = await importExtensionSkills([f.loaded]);
		repos.transaction((tx) => tx.skills.reconcileExtensions(updated));
		expect(repos.skills.resolveActive(["review"])[1].revisionId).not.toBe(selected[1].revisionId);
		expect(repos.processSkills.listResourceLayers(process.id)).toEqual(pinned);
		expect(repos.skills.remove("review")).toBe(false);
		repos.transaction((tx) => tx.skills.reconcileExtensions([]));
		expect(repos.skills.listAvailable()).toEqual([]);
		closeDatabase(db);
		db = createDatabase({ sqlitePath });
		repos = createAllRepos(db);
		expect(repos.processSkills.listSelections(process.id)).toEqual(selected);
		expect(repos.processSkills.listResourceLayers(process.id)).toEqual(pinned);
		const files = verifyCanonicalPiResourceBundle(pinned[1].bundle.bytes, pinned[1].bundle.digest);
		expect(
			Buffer.from(files.find((file) => file.path.endsWith("SKILL.md"))?.content ?? []).toString(),
		).not.toContain("Updated instructions");
	});

	it("changes revision identity when only provenance or dependencies change", async () => {
		const f = await fixture();
		const first = await importExtensionSkills([f.loaded]);
		f.manifest.skills[0].dependencies = [];
		await writeFile(f.skillPackPath, JSON.stringify(f.manifest));
		const second = await importExtensionSkills([f.loaded]);
		expect(second[0].bundle.digest).not.toBe(first[0].bundle.digest);
	});

	it("rejects competing owners and repository replacement without changing active revisions", async () => {
		const f = await fixture();
		const db = createDatabase({ sqlitePath: ":memory:" });
		onTestFinished(() => closeDatabase(db));
		const repos = createAllRepos(db);
		const imported = await importExtensionSkills([f.loaded]);
		repos.transaction((tx) => tx.skills.reconcileExtensions(imported));
		const selected = repos.skills.resolveActive(["review"]);
		const competing = imported.map((skill) => ({
			...skill,
			provenance: { ...skill.provenance, extensionId: "competitor" },
		}));
		expect(() => repos.transaction((tx) => tx.skills.reconcileExtensions(competing))).toThrow(
			"already owned",
		);
		expect(() => repos.transaction((tx) => tx.skills.reconcileExtensions([imported[0]]))).toThrow(
			"Missing pack dependency",
		);
		expect(repos.skills.resolveActive(["review"])).toEqual(selected);
		repos.skills.mergeCatalog(
			"remote",
			imported.map((skill) => ({ ...skill, sourcePath: skill.provenance.sourcePath })),
		);
		expect(repos.skills.catalog().availableSkills.every((skill) => skill.conflict)).toBe(true);
		expect(() =>
			repos.transaction((tx) => tx.skills.registerCatalogEntry("remote", "review")),
		).toThrow("managed by test-skills");
		repos.transaction((tx) => tx.skills.reconcileExtensions([]));
		expect(() => repos.skills.registerCatalogEntry("remote", "review")).toThrow(
			"managed by test-skills",
		);
	});

	it("rejects missing dependencies, frontmatter drift, and symlinked resources", async () => {
		const f = await fixture();
		f.manifest.skills[0].dependencies = ["missing"];
		await writeFile(f.skillPackPath, JSON.stringify(f.manifest));
		await expect(importExtensionSkills([f.loaded])).rejects.toThrow(
			"Missing skill pack dependency",
		);
		f.manifest.skills[0].dependencies = ["design"];
		await writeFile(f.skillPackPath, JSON.stringify(f.manifest));
		const root = path.join(f.root, "dist/skills/review");
		await writeFile(path.join(root, "SKILL.md"), "# Invalid skill");
		await expect(importExtensionSkills([f.loaded])).rejects.toThrow("frontmatter");
		await rm(root, { recursive: true });
		await symlink("design", root);
		await expect(importExtensionSkills([f.loaded])).rejects.toThrow("symlink");
	});
});
