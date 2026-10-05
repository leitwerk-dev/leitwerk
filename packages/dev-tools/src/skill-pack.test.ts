import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, onTestFinished } from "vitest";
import { buildSkillPack, runSkillPackCli } from "./skill-pack.js";

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), "skill-pack-test-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "upstream/skills/review"), { recursive: true });
	await mkdir(path.join(root, "patches"));
	const recipe = {
		upstream: { url: "https://example.invalid/skills.git", commit: "a".repeat(40) },
		licenses: ["LICENSE"],
		skills: [{ id: "review", sourcePath: "skills/review", dependencies: [] as string[] }],
	};
	await writeFile(path.join(root, "skill-pack.json"), JSON.stringify(recipe));
	await writeFile(path.join(root, "patches/leitwerk.patch"), "");
	await writeFile(path.join(root, "upstream/LICENSE"), "Upstream attribution\n");
	await writeFile(
		path.join(root, "upstream/skills/review/SKILL.md"),
		"---\nname: review\ndescription: Review architecture\n---\nOriginal instructions\n",
	);
	await writeFile(path.join(root, "upstream/skills/review/OLD.md"), "Old template\n");
	const args = ["--package", root];
	return {
		root,
		recipe,
		args,
		work: path.join(root, ".skill-pack/work/skills/review"),
		output: path.join(root, "dist/skills"),
	};
}

describe("skill-pack maintenance", () => {
	it("round-trips edited, added, and deleted resources through an offline reproducible build", async () => {
		const f = await fixture();
		await runSkillPackCli("skills:prepare", f.args);
		const adapted =
			"---\nname: review\ndescription: Review architecture\n---\nRead [report](REPORT.md).\n";
		await writeFile(path.join(f.work, "SKILL.md"), adapted);
		await rm(path.join(f.work, "OLD.md"));
		await writeFile(path.join(f.work, "REPORT.md"), "```mermaid\nflowchart LR\n A --> B\n```\n");
		await runSkillPackCli("skills:diff", f.args);
		await buildSkillPack(f.root);
		expect(await readFile(path.join(f.output, "review/SKILL.md"), "utf8")).toBe(adapted);
		expect(await readFile(path.join(f.output, "review/licenses/LICENSE"), "utf8")).toBe(
			"Upstream attribution\n",
		);
		await expect(readFile(path.join(f.output, "review/OLD.md"))).rejects.toThrow();
		const manifest = await readFile(path.join(f.output, "manifest.json"), "utf8");
		await buildSkillPack(f.root);
		expect(await readFile(path.join(f.output, "manifest.json"), "utf8")).toBe(manifest);
		await rm(path.join(f.root, ".skill-pack"), { recursive: true });
		await runSkillPackCli("skills:prepare", f.args);
		expect(await readFile(path.join(f.work, "SKILL.md"), "utf8")).toBe(adapted);
		await expect(runSkillPackCli("skills:prepare", f.args)).rejects.toThrow("Remove or move");
	});

	it("preserves the previous output when a patch no longer applies", async () => {
		const f = await fixture();
		await runSkillPackCli("skills:prepare", f.args);
		await writeFile(path.join(f.work, "OLD.md"), "New template\n");
		await runSkillPackCli("skills:diff", f.args);
		await buildSkillPack(f.root);
		const manifest = await readFile(path.join(f.output, "manifest.json"), "utf8");
		await writeFile(path.join(f.root, "upstream/skills/review/OLD.md"), "Upstream changed\n");
		await expect(buildSkillPack(f.root)).rejects.toThrow(/patch.*OLD.md|OLD.md.*patch/s);
		expect(await readFile(path.join(f.output, "manifest.json"), "utf8")).toBe(manifest);
		expect(await readFile(path.join(f.output, "review/OLD.md"), "utf8")).toBe("New template\n");
	});

	it("rejects missing dependencies, broken resources, and symlinks before publishing", async () => {
		const f = await fixture();
		f.recipe.skills[0].dependencies = ["missing"];
		await writeFile(path.join(f.root, "skill-pack.json"), JSON.stringify(f.recipe));
		await expect(buildSkillPack(f.root)).rejects.toThrow("Missing skill pack dependency");
		f.recipe.skills[0].dependencies = [];
		await writeFile(path.join(f.root, "skill-pack.json"), JSON.stringify(f.recipe));
		await writeFile(
			path.join(f.root, "upstream/skills/review/OLD.md"),
			"Read [missing](missing.md).\n",
		);
		await expect(buildSkillPack(f.root)).rejects.toThrow("broken resource link");
		await symlink("../../LICENSE", path.join(f.root, "upstream/skills/review/link"));
		await expect(buildSkillPack(f.root)).rejects.toThrow("regular files");
	});

	it("fetches only on explicit prepare --ref and pins the resolved commit", async () => {
		const f = await fixture();
		const upstream = path.join(f.root, "upstream");
		const git = async (...args: string[]) =>
			(await promisify(execFile)("git", ["-C", upstream, ...args])).stdout.trim();
		await git("init", "--quiet");
		await git("add", ".");
		await git(
			"-c",
			"user.name=Skill Fixture",
			"-c",
			"user.email=fixture@example.test",
			"commit",
			"-s",
			"-qm",
			"Fixture",
		);
		const commit = await git("rev-parse", "HEAD");
		f.recipe.upstream.url = upstream;
		await writeFile(path.join(f.root, "skill-pack.json"), JSON.stringify(f.recipe));
		await runSkillPackCli("skills:prepare", [...f.args, "--ref", commit]);
		const recipe = JSON.parse(await readFile(path.join(f.root, "skill-pack.json"), "utf8"));
		expect(recipe.upstream.commit).toBe(commit);
		await buildSkillPack(f.root);
		expect(
			JSON.parse(await readFile(path.join(f.output, "manifest.json"), "utf8")).upstream.commit,
		).toBe(commit);
	});
});
