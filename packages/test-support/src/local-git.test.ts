import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { LocalGit, LocalGitSeedCache, readLocalJson, writeLocalJson } from "./local-git.js";

test("local repositories resume seeds and reject escaping paths and symlinks", ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "local-git-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const git = new LocalGit(root);
	const seed = { owner: "team", name: "repo", files: { "notes.txt": "original" } };
	const repo = git.seed({ ...seed, commitMessage: "seed", signoff: true });
	const head = git.head(repo.bare, "main");
	expect(git.run(repo.bare, ["log", "-1", "--format=%B"])).toBe(
		"seed\n\nSigned-off-by: Sandbox Developer <developer@sandbox.invalid>",
	);
	git.seed({ ...seed, files: { "notes.txt": "must not replace retained repository" } });
	expect(git.head(repo.bare, "main")).toBe(head);
	expect(() => git.run(path.dirname(root), ["status"])).toThrow("escapes");
	expect(() => git.seed({ ...seed, name: "escape", files: { "../outside": "escape" } })).toThrow(
		"escapes",
	);
	expect(() => git.seed({ ...seed, name: "config", files: { ".git/config": "escape" } })).toThrow(
		"configuration",
	);
	writeLocalJson(root, "provider.json", { version: 1, retained: true });
	expect(statSync(path.join(root, "provider.json")).mode & 0o777).toBe(0o600);
	expect(readLocalJson(root, "provider.json", { version: 1 })).toMatchObject({ retained: true });
	symlinkSync(path.join(root, "provider.json"), path.join(root, "alias.json"));
	expect(() => writeLocalJson(root, "alias.json", {})).toThrow("symlink");
	expect(readFileSync(path.join(root, "provider.json"), "utf8")).toContain("retained");
	symlinkSync(root, path.join(root, "root-alias"));
	expect(() =>
		readLocalJson(path.join(root, "root-alias"), "provider.json", { version: 1 }),
	).toThrow("symlink");
});

test("cached seeds preserve independent refs, configuration and seed contents", ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "local-git-copies-"));
	const seeds = new LocalGitSeedCache();
	onTestFinished(() => {
		seeds.close();
		rmSync(root, { recursive: true, force: true });
	});
	const first = new LocalGit(path.join(root, "first"));
	const second = new LocalGit(path.join(root, "second"));
	const third = new LocalGit(path.join(root, "third"));
	const seed = {
		owner: "team",
		name: "repo",
		defaultBranch: "release",
		files: { "notes.txt": "original" },
	};
	const firstRepo = seeds.copy(first, seed);
	const secondRepo = seeds.copy(second, seed);
	const initial = first.head(firstRepo, "release");
	const changed = first.run(firstRepo, [
		"commit-tree",
		`${initial}^{tree}`,
		"-p",
		initial,
		"-m",
		"fixture change",
	]);
	first.run(firstRepo, ["update-ref", "refs/heads/release", changed]);
	const config = path.join(firstRepo, "config");
	writeFileSync(config, `${readFileSync(config, "utf8")}\n[test]\n\tfixture = first\n`);
	const thirdRepo = seeds.copy(third, seed);
	expect(first.head(firstRepo, "release")).toBe(changed);
	expect(second.head(secondRepo, "release")).toBe(initial);
	expect(third.head(thirdRepo, "release")).toBe(initial);
	expect(readFileSync(path.join(secondRepo, "config"), "utf8")).not.toContain("fixture = first");
	expect(readFileSync(path.join(thirdRepo, "config"), "utf8")).not.toContain("fixture = first");
	expect(() => seeds.copy(first, seed)).toThrow("already exists");
	expect(first.head(firstRepo, "release")).toBe(changed);
	const variant = new LocalGit(path.join(root, "variant"));
	const variantRepo = seeds.copy(variant, { ...seed, files: { "notes.txt": "different" } });
	seeds.close();
	expect(variant.run(variantRepo, ["show", "release:notes.txt"])).toBe("different");
	expect(second.run(secondRepo, ["show", "release:notes.txt"])).toBe("original");
});
