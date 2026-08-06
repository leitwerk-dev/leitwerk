import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { verifyCanonicalPiResourceBundle } from "@leitwerk-dev/worker-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { importConfiguredSkills, importSkillRepository } from "./source-importer.js";

const execFileAsync = promisify(execFile);

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const root = await mkdtemp(path.join(os.tmpdir(), "leitwerk-skill-import-"));
	temporaryDirectories.push(root);
	return root;
}

describe("configured skill import", () => {
	it("imports a complete skill as a canonical Pi resource fragment", async () => {
		const root = await temporaryDirectory();
		await mkdir(path.join(root, "review", "references"), { recursive: true });
		await writeFile(path.join(root, "review", "SKILL.md"), "# Review\n");
		await writeFile(path.join(root, "review", "references", "rules.md"), "Rules\n");

		const [imported] = await importConfiguredSkills(
			[
				{
					id: "review",
					label: "Review",
					source: { kind: "local", path: "review" },
				},
			],
			root,
		);
		expect(imported?.sourceRevision).toBeNull();
		expect(
			verifyCanonicalPiResourceBundle(
				imported?.bundle.bytes ?? new Uint8Array(),
				imported?.bundle.digest,
			).map((file) => file.path),
		).toEqual(["skills/review/SKILL.md", "skills/review/references/rules.md"]);
	});

	it("discovers arbitrarily nested skill directories from a Git repository", async () => {
		const root = await temporaryDirectory();
		await mkdir(path.join(root, "skills", "engineering", "review", "references"), {
			recursive: true,
		});
		await mkdir(path.join(root, "skills", "productivity", "planning"), { recursive: true });
		await mkdir(path.join(root, "skills", "not-a-skill"), { recursive: true });
		await writeFile(
			path.join(root, "skills", "engineering", "review", "SKILL.md"),
			"---\nname: Review changes\ndescription: Review a branch\n---\n# Review\n",
		);
		await writeFile(
			path.join(root, "skills", "engineering", "review", "references", "rules.md"),
			"Rules\n",
		);
		await writeFile(
			path.join(root, "skills", "productivity", "planning", "SKILL.md"),
			"# Planning\n",
		);
		await execFileAsync("git", ["init", "--quiet", root]);
		await execFileAsync("git", ["-C", root, "add", "."]);
		await execFileAsync("git", [
			"-C",
			root,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		]);

		const imported = await importSkillRepository({
			id: "shared",
			url: root,
			ref: "HEAD",
		});

		expect(imported.skills).toEqual([
			expect.objectContaining({
				skillId: "review",
				label: "Review changes",
				description: "Review a branch",
				sourcePath: "skills/engineering/review",
				sourceRevision: imported.commit,
			}),
			expect.objectContaining({
				skillId: "planning",
				label: "Planning",
				description: null,
				sourcePath: "skills/productivity/planning",
				sourceRevision: imported.commit,
			}),
		]);
	});

	it("requires a root SKILL.md", async () => {
		const root = await temporaryDirectory();
		await mkdir(path.join(root, "invalid"));
		await writeFile(path.join(root, "invalid", "notes.md"), "Notes\n");
		await expect(
			importConfiguredSkills([{ id: "invalid", source: { kind: "local", path: "invalid" } }], root),
		).rejects.toThrow(/root SKILL\.md/);
	});
});
