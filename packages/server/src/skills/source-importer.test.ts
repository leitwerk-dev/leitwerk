import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { importSkillRepository } from "./source-importer.js";

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

async function commitFixture(root: string): Promise<void> {
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
}

describe("skill repository import", () => {
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
		await commitFixture(root);

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

	it("imports a repository path that points directly to one skill", async () => {
		const root = await temporaryDirectory();
		await mkdir(path.join(root, ".pi", "skills", "impeccable"), { recursive: true });
		await writeFile(
			path.join(root, ".pi", "skills", "impeccable", "SKILL.md"),
			"---\nname: Impeccable\ndescription: Refine interfaces\n---\n# Impeccable\n",
		);
		await commitFixture(root);

		const imported = await importSkillRepository({
			id: "impeccable",
			url: root,
			ref: "HEAD",
			path: ".pi/skills/impeccable",
		});

		expect(imported.skills).toEqual([
			expect.objectContaining({
				skillId: "impeccable",
				label: "Impeccable",
				description: "Refine interfaces",
				sourcePath: ".pi/skills/impeccable",
			}),
		]);
	});
});
