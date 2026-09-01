import path from "node:path";
import { FakeGitOps, type RepoTemplate } from "@leitwerk-dev/test-support/fakes";
import { describe, expect, it } from "vitest";
import { deserializeManifest, serializeManifest } from "./manifest.js";
import {
	materializeRunRoot,
	planRunRoot,
	type RunRootGitOps,
	RunRootPreparationError,
	repairRunRoot,
	validateRunRoot,
} from "./run-root.js";

describe("materializeRunRoot", () => {
	it("rejects component keys that escape the workspace root", async () => {
		const ws = path.join("/", "work", "space");
		const git: RunRootGitOps = new FakeGitOps(new Map());
		const plan = planRunRoot(ws, "ag-escape", [
			{
				key: "../escape",
				repoLocator: "https://example.com/escape.git",
				baseBranch: "main",
				workBranch: "feature",
			},
		]);

		await expect(materializeRunRoot(plan, git)).rejects.toThrow(/outside workspace root/);
	});

	it("fails preparation when a component cannot be cloned", async () => {
		const ws = path.join("/", "work", "failed");
		const git: RunRootGitOps = new FakeGitOps(new Map());
		const plan = planRunRoot(ws, "ag-failed", [
			{
				key: "repo",
				repoLocator: "https://example.com/missing.git",
				baseBranch: "main",
				workBranch: "feature",
			},
		]);

		const preparation = materializeRunRoot(plan, git);
		await expect(preparation).rejects.toBeInstanceOf(RunRootPreparationError);
		await expect(preparation).rejects.toThrow(/repo: unknown repo/);
	});

	it("clones components, checks out feature branches, writes manifest and aggregated AGENTS.md", async () => {
		const ws = path.join("/", "work", "space");
		const templates = new Map<string, RepoTemplate>([
			[
				"https://example.com/a.git",
				{
					"AGENTS.md": "alpha",
					".cursor/skills/sa/SKILL.md": "skill-a",
				},
			],
			[
				"https://example.com/b.git",
				{
					"AGENTS.md": "beta",
				},
			],
		]);
		const git: RunRootGitOps = new FakeGitOps(templates);
		const plan = planRunRoot(ws, "ag-1", [
			{
				key: "b",
				repoLocator: "https://example.com/b.git",
				baseBranch: "main",
				workBranch: "fb",
			},
			{
				key: "a",
				repoLocator: "https://example.com/a.git",
				baseBranch: "main",
				workBranch: "fa",
			},
		]);
		const result = await materializeRunRoot(plan, git);
		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.loadedSkills).toEqual(["sa"]);

		const manifestPath = path.join(".leitwerk", "components.json");
		const raw = await git.readFile(ws, manifestPath);
		if (typeof raw !== "string") {
			throw new Error("expected manifest file");
		}
		const parsed = deserializeManifest(raw);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.manifest.instanceId).toBe("ag-1");
			expect(parsed.manifest.components.map((c) => c.key).sort()).toEqual(["a", "b"]);
		}

		const processes = await git.readFile(ws, "AGENTS.md");
		if (typeof processes !== "string") {
			throw new Error("expected AGENTS.md");
		}
		expect(processes).toContain("<!-- source: a/AGENTS.md -->");
		expect(processes).toContain("<!-- source: b/AGENTS.md -->");
		expect(processes.indexOf("a/AGENTS")).toBeLessThan(processes.indexOf("b/AGENTS"));
		expect(result.aggregatedAgentsMdSources).toEqual(["a/AGENTS.md", "b/AGENTS.md"]);
	});
});

describe("validateRunRoot", () => {
	it("detects stale, missing, and extra components", async () => {
		const ws = path.join("/", "v", "ws");
		const git: RunRootGitOps = new FakeGitOps(new Map());
		const existing = {
			version: 1 as const,
			instanceId: "a",
			createdAt: "t",
			components: [
				{
					key: "ok",
					repoLocator: "https://same.git",
					baseBranch: "main",
					workBranch: "f",
					clonedAt: "c",
					headSha: "h",
				},
				{
					key: "stale",
					repoLocator: "https://old.git",
					baseBranch: "main",
					workBranch: "f",
					clonedAt: "c",
					headSha: "h",
				},
				{
					key: "extra",
					repoLocator: "https://x.git",
					baseBranch: "main",
					workBranch: "f",
					clonedAt: "c",
					headSha: "h",
				},
			],
		};
		await git.writeFile(ws, path.join(".leitwerk", "components.json"), serializeManifest(existing));

		const server = [
			{
				key: "ok",
				repoLocator: "https://same.git",
				baseBranch: "main",
				workBranch: "f",
			},
			{
				key: "stale",
				repoLocator: "https://new.git",
				baseBranch: "main",
				workBranch: "f",
			},
			{ key: "missing", repoLocator: "https://m.git", baseBranch: "main", workBranch: "f" },
		];

		const v = await validateRunRoot(ws, server, git);
		expect(v.valid).toBe(false);
		expect(v.diff.stale).toEqual(["stale"]);
		expect(v.diff.missing).toEqual(["missing"]);
		expect(v.diff.extra).toEqual(["extra"]);
		expect(v.diff.unchanged).toEqual(["ok"]);
	});
});

describe("repairRunRoot", () => {
	it("fails preparation when an empty resumed workspace cannot be repaired", async () => {
		const ws = path.join("/", "r", "failed");
		const git: RunRootGitOps = new FakeGitOps(new Map());
		const projects = [
			{
				key: "repo",
				repoLocator: "https://example.com/missing.git",
				baseBranch: "main",
				workBranch: "feature",
			},
		];
		const validation = await validateRunRoot(ws, projects, git);

		expect(validation.diff.missing).toEqual(["repo"]);
		await expect(
			repairRunRoot(ws, validation, planRunRoot(ws, "ag-resumed", projects), git),
		).rejects.toThrow(/Workspace preparation failed: repo: unknown repo/);
	});

	it("re-clones stale components and refreshes manifest", async () => {
		const ws = path.join("/", "r", "ws");
		const templates = new Map<string, RepoTemplate>([
			[
				"https://new.git",
				{
					"AGENTS.md": "fixed",
				},
			],
			[
				"https://keep.git",
				{
					"AGENTS.md": "keep",
				},
			],
		]);
		const git: RunRootGitOps = new FakeGitOps(templates);

		const existing = {
			version: 1 as const,
			instanceId: "a",
			createdAt: "t",
			components: [
				{
					key: "keep",
					repoLocator: "https://keep.git",
					baseBranch: "main",
					workBranch: "fk",
					clonedAt: "c1",
					headSha: "1111111111111111111111111111111111111111",
				},
				{
					key: "stale",
					repoLocator: "https://old.git",
					baseBranch: "main",
					workBranch: "fs",
					clonedAt: "c2",
					headSha: "2222222222222222222222222222222222222222",
				},
			],
		};
		await git.writeFile(ws, path.join(".leitwerk", "components.json"), serializeManifest(existing));
		await git.writeFile(path.join(ws, "keep"), "AGENTS.md", "keep");

		const server = [
			{
				key: "keep",
				repoLocator: "https://keep.git",
				baseBranch: "main",
				workBranch: "fk",
			},
			{
				key: "stale",
				repoLocator: "https://new.git",
				baseBranch: "main",
				workBranch: "fs",
			},
		];

		const validation = await validateRunRoot(ws, server, git);
		expect(validation.diff.stale).toEqual(["stale"]);

		const plan = planRunRoot(ws, "a2", server);
		const repaired = await repairRunRoot(ws, validation, plan, git);
		expect(repaired.ok).toBe(true);

		const staleEntry = repaired.manifest.components.find((c) => c.key === "stale");
		expect(staleEntry?.repoLocator).toBe("https://new.git");
		expect(staleEntry?.headSha).not.toBe("2222222222222222222222222222222222222222");

		const keepEntry = repaired.manifest.components.find((c) => c.key === "keep");
		expect(keepEntry?.headSha).toBe("1111111111111111111111111111111111111111");

		const processes = await git.readFile(ws, "AGENTS.md");
		expect(processes).toContain("fixed");
		expect(processes).toContain("keep");
	});
});
