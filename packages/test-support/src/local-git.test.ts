import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { LocalGit, readLocalJson, writeLocalJson } from "./local-git.js";

test("local repositories resume seeds and reject escaping paths and symlinks", ({
	onTestFinished,
}) => {
	const root = mkdtempSync(path.join(tmpdir(), "local-git-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const git = new LocalGit(root);
	const seed = { owner: "team", name: "repo", files: { "notes.txt": "original" } };
	const repo = git.seed(seed);
	const head = git.head(repo.bare, "main");
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
});
