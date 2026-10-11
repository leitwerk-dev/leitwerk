import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TurnDiagnosticReport } from "@leitwerk-dev/process-sdk";
import { resetGitBinaryCache, resolveGitBinary } from "@leitwerk-dev/process-sdk/git-binary";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codingPurposes, commitMessageGitTimeout } from "../settings.js";
import { prepareRepositoryCommitMessageEvidence } from "./commit-message-evidence.js";
import type { GitTrace2Summary } from "./git-inspection-profile.js";

const directories: string[] = [];

function git(cwd: string, ...args: string[]): string {
	return execFileSync(resolveGitBinary(), ["--no-optional-locks", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function repository(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "commit-message-evidence-"));
	directories.push(dir);
	git(dir, "init", "--initial-branch=main");
	git(dir, "config", "user.name", "Test User");
	git(dir, "config", "user.email", "test@example.com");
	writeFileSync(path.join(dir, "feature.txt"), "Original behavior\n");
	writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
	git(dir, "add", ".");
	git(dir, "commit", "-m", "Initial behavior");
	return dir;
}

function context(repositories: Record<string, string>) {
	return {
		projects: Object.keys(repositories).map((key) => ({ key })),
		repo: { get: (key: string) => ({ fsPath: repositories[key] }) },
	};
}

function wrapGit(options: { delayStatusMs?: number; failStatus?: boolean } = {}): string {
	const binary = resolveGitBinary();
	const dir = mkdtempSync(path.join(tmpdir(), "commit-message-delayed-git-"));
	directories.push(dir);
	const calls = path.join(dir, "calls.jsonl");
	writeFileSync(
		path.join(dir, "git"),
		`#!${process.execPath}
const { spawn } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  args, indexFile: process.env.GIT_INDEX_FILE, optionalLocks: process.env.GIT_OPTIONAL_LOCKS
}) + "\\n");
if (${options.failStatus ?? false} && args.includes("status")) process.exit(7);
setTimeout(() => {
  const stdio = process.env.GIT_TRACE2_EVENT === "3" ? ["inherit", "inherit", "inherit", 3] : "inherit";
  const child = spawn(${JSON.stringify(binary)}, args, { stdio });
  child.once("error", () => process.exit(1));
  child.once("close", (code) => process.exit(code ?? 1));
}, args.includes("status") ? ${options.delayStatusMs ?? 0} : 0);
`,
		{ mode: 0o700 },
	);
	vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH}`);
	resetGitBinaryCache();
	return calls;
}

function capturedCalls(
	file: string,
): { args: string[]; indexFile?: string; optionalLocks: string }[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

function expectScratchRemoved(calls: string): void {
	const indexes = capturedCalls(calls).flatMap(({ indexFile }) => (indexFile ? [indexFile] : []));
	expect(indexes.length).toBeGreaterThan(0);
	for (const index of indexes) expect(existsSync(path.dirname(index))).toBe(false);
}

afterEach(() => {
	vi.unstubAllEnvs();
	resetGitBinaryCache();
	for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("commit-message repository evidence", () => {
	it("inspects valid changes when Git status takes longer than the former 10-second deadline", async () => {
		const repo = repository();
		const index = readFileSync(path.join(repo, ".git/index"));
		writeFileSync(path.join(repo, "feature.txt"), "Slowly inspected behavior\n");
		const calls = wrapGit({ delayStatusMs: 11_000 });

		const evidence = await prepareRepositoryCommitMessageEvidence(context({ repo }));
		expect(evidence.repositories[0].status.text).toContain("feature.txt");
		expect(evidence.repositories[0].unstagedDiff.text).toContain("+Slowly inspected behavior");
		expect(readFileSync(path.join(repo, ".git/index"))).toEqual(index);
		expectScratchRemoved(calls);
	}, 30_000);

	it("enforces the captured configured deadline and identifies the timed-out command", async () => {
		const repo = repository();
		const index = readFileSync(path.join(repo, ".git/index"));
		const calls = wrapGit({ delayStatusMs: 4_000 });
		const reportDiagnostic = vi.fn();
		const scopedSettings = {
			version: 1 as const,
			purpose: codingPurposes.implementation,
			context: { instance: "installation" },
			values: [{ key: commitMessageGitTimeout.key, value: 2_000, sources: [] }],
			instructions: [],
			explanations: [],
		};

		await expect(
			prepareRepositoryCommitMessageEvidence({
				...context({ repo }),
				scopedSettings,
				reportDiagnostic,
			}),
		).rejects.toThrow("Cannot inspect 'repo': git status timed out after 2000ms");
		expect(reportDiagnostic).toHaveBeenLastCalledWith(
			expect.objectContaining({
				code: "coding.git_inspection",
				details: expect.objectContaining({
					command: "status",
					outcome: "timed_out",
					timeoutMs: 2_000,
				}),
			}),
		);
		expect(readFileSync(path.join(repo, ".git/index"))).toEqual(index);
		expectScratchRemoved(calls);
	});

	it("reuses refreshed stat data without rehashing clean files or changing the original index", async () => {
		const repo = repository();
		git(repo, "config", "core.trustctime", "true");
		git(repo, "config", "core.checkStat", "default");
		const unchanged = Array.from({ length: 40 }, (_, index) =>
			path.join(repo, `unchanged-${index}.txt`),
		);
		for (const file of unchanged) writeFileSync(file, "Unchanged content\n".repeat(1_000));
		const timestamp = new Date(Date.now() - 5_000);
		for (const file of [
			...unchanged,
			path.join(repo, "feature.txt"),
			path.join(repo, ".gitignore"),
		])
			utimesSync(file, timestamp, timestamp);
		git(repo, "add", ".");
		git(repo, "commit", "-m", "Add unchanged files");
		git(repo, "update-index", "--refresh");
		const index = readFileSync(path.join(repo, ".git/index"));
		// Some Git builds compare ctime at whole-second precision. Cross that
		// boundary while keeping content, size, and mtime unchanged.
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		for (const file of unchanged) {
			chmodSync(file, 0o600);
			chmodSync(file, 0o644);
		}
		const reports: TurnDiagnosticReport[] = [];
		const calls = wrapGit();
		const evidence = await prepareRepositoryCommitMessageEvidence({
			...context({ repo }),
			reportDiagnostic: (report) => reports.push(report),
		});
		expect(evidence.repositories[0].status.text).toBe("");
		expect(evidence.repositories[0].unstagedDiff.text).toBe("");
		expect(readFileSync(path.join(repo, ".git/index"))).toEqual(index);
		expect(reports.map(({ details }) => details?.command)).toEqual([
			"rev-parse.head",
			"rev-parse.index",
			"status",
			"diff.staged",
			"diff.unstaged",
			"ls-files.untracked",
		]);
		const status = reports.find(({ details }) => details?.command === "status");
		const diff = reports.find(({ details }) => details?.command === "diff.unstaged");
		expect(status?.details?.trace2).toMatchObject({
			counters: { "index/refresh/sum_scan": 40 },
			incomplete: false,
		});
		expect(diff?.details?.trace2).toMatchObject({
			counters: { "index/read/cache_nr": 42 },
			incomplete: false,
		});
		// Git may skip the refresh phase entirely when the cached stat data matches.
		const diffTrace = diff?.details?.trace2 as GitTrace2Summary;
		expect(diffTrace.counters["index/refresh/sum_scan"] ?? 0).toBe(0);
		for (const report of reports) {
			expect(report.details).toMatchObject({
				durationMs: expect.any(Number),
				outcome: "succeeded",
				exitCode: 0,
			});
			expect(JSON.stringify(report)).not.toContain(repo);
			expect(JSON.stringify(report)).not.toContain("unchanged-0.txt");
		}
		const inspection = capturedCalls(calls).filter(({ indexFile }) => indexFile);
		expect(new Set(inspection.map(({ indexFile }) => indexFile)).size).toBe(1);
		expect(inspection.every(({ optionalLocks }) => optionalLocks === "1")).toBe(true);
		expectScratchRemoved(calls);
	});

	it.each([
		"split",
		"linked",
		"missing",
	])("preserves checkout state with a %s index", async (kind) => {
		const main = repository();
		let repo = main;
		if (kind === "split") {
			git(repo, "config", "core.splitIndex", "true");
			git(repo, "update-index", "--split-index");
		} else if (kind === "linked") {
			repo = mkdtempSync(path.join(tmpdir(), "commit-message-worktree-"));
			directories.push(repo);
			git(main, "worktree", "add", repo, "-b", "feature");
		}
		const indexPath = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index");
		if (kind === "missing") rmSync(indexPath);
		const index = existsSync(indexPath) ? readFileSync(indexPath) : undefined;
		const sharedIndexes = readdirSync(path.join(main, ".git")).filter((name) =>
			name.startsWith("sharedindex."),
		);
		const sharedContents = sharedIndexes.map((name) => readFileSync(path.join(main, ".git", name)));
		writeFileSync(path.join(repo, "feature.txt"), "Changed behavior\n");
		const status = git(repo, "status", "--porcelain=v1", "--untracked-files=all");
		const head = git(repo, "rev-parse", "HEAD");
		const evidence = await prepareRepositoryCommitMessageEvidence(context({ repo }));
		expect(evidence.repositories[0].status.text.trim()).toBe(status);
		expect(evidence.repositories[0].head).toBe(head);
		if (index) expect(readFileSync(indexPath)).toEqual(index);
		else expect(existsSync(indexPath)).toBe(false);
		expect(
			readdirSync(path.join(main, ".git")).filter((name) => name.startsWith("sharedindex.")),
		).toEqual(sharedIndexes);
		expect(sharedIndexes.map((name) => readFileSync(path.join(main, ".git", name)))).toEqual(
			sharedContents,
		);
		expect(readFileSync(path.join(repo, "feature.txt"), "utf8")).toBe("Changed behavior\n");
	});

	it("preserves racy-index detection for same-size changes with unchanged timestamps", async () => {
		const repo = repository();
		const feature = path.join(repo, "feature.txt");
		const indexPath = path.join(repo, ".git/index");
		const timestamp = new Date(Date.now() - 5_000);
		utimesSync(feature, timestamp, timestamp);
		git(repo, "update-index", "--refresh");
		git(repo, "config", "core.trustctime", "false");
		git(repo, "config", "core.checkStat", "minimal");
		utimesSync(indexPath, timestamp, timestamp);
		const index = readFileSync(indexPath);
		writeFileSync(feature, "Modified behavior\n");
		utimesSync(feature, timestamp, timestamp);

		const evidence = await prepareRepositoryCommitMessageEvidence(context({ repo }));
		expect(evidence.repositories[0].status.text).toContain(" M feature.txt");
		expect(evidence.repositories[0].unstagedDiff.text).toContain("+Modified behavior");
		expect(evidence.repositories[0].stagedDiff.text).toBe("");
		expect(readFileSync(indexPath)).toEqual(index);
		expect(statSync(indexPath).mtimeMs).toBe(timestamp.getTime());
	});

	it("cleans scratch state and retains the Git failure even when diagnostic reporting throws", async () => {
		const repo = repository();
		const index = readFileSync(path.join(repo, ".git/index"));
		const calls = wrapGit({ failStatus: true });
		const reports: TurnDiagnosticReport[] = [];
		await expect(
			prepareRepositoryCommitMessageEvidence({
				...context({ repo }),
				reportDiagnostic: (report) => {
					reports.push(report);
					throw new Error("diagnostic transport unavailable");
				},
			}),
		).rejects.toThrow("Cannot inspect 'repo': git status failed (7)");
		expect(reports.at(-1)?.details).toMatchObject({
			command: "status",
			outcome: "failed",
			exitCode: 7,
		});
		expect(readFileSync(path.join(repo, ".git/index"))).toEqual(index);
		expectScratchRemoved(calls);
	});

	it("ignores ambient index selection and raw trace destinations", async () => {
		const repo = repository();
		const ambientIndex = path.join(repo, ".git/ambient-index");
		writeFileSync(ambientIndex, "Invalid unrelated index");
		const tracePath = path.join(repo, ".git/raw-trace");
		git(repo, "config", "trace2.normalTarget", tracePath);
		vi.stubEnv("GIT_INDEX_FILE", ambientIndex);
		for (const key of ["GIT_TRACE", "GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_TRACE2_PERF"])
			vi.stubEnv(key, tracePath);
		vi.stubEnv("GIT_OPTIONAL_LOCKS", "0");
		const evidence = await prepareRepositoryCommitMessageEvidence(context({ repo }));
		expect(evidence.repositories[0].status.text).toBe("");
		expect(readFileSync(ambientIndex, "utf8")).toBe("Invalid unrelated index");
		expect(existsSync(tracePath)).toBe(false);
	});

	it("separates staged, unstaged, and untracked work by repository without changing Git state", async () => {
		const first = repository();
		const second = repository();
		writeFileSync(path.join(first, "feature.txt"), "Staged behavior\n");
		git(first, "add", "feature.txt");
		writeFileSync(path.join(first, "feature.txt"), "Final behavior\n");
		writeFileSync(path.join(first, "new file.txt"), "Untracked behavior\n");
		writeFileSync(path.join(first, "ignored.txt"), "Ignored behavior\n");
		const head = git(first, "rev-parse", "HEAD");
		const index = readFileSync(path.join(first, ".git/index"));
		const status = git(first, "status", "--porcelain=v1", "--untracked-files=all");

		const { repositories } = await prepareRepositoryCommitMessageEvidence(
			context({ repo_a: first, repo_b: second }),
		);
		expect(repositories.map(({ key, path }) => ({ key, path }))).toEqual([
			{ key: "repo_a", path: first },
			{ key: "repo_b", path: second },
		]);
		expect(repositories[0].head).toBe(head);
		expect(repositories[0].status.text.trim()).toBe(status);
		expect(repositories[0].stagedDiff.text).toContain("+Staged behavior");
		expect(repositories[0].stagedDiff.text).not.toContain("Final behavior");
		expect(repositories[0].unstagedDiff.text).toContain("-Staged behavior\n+Final behavior");
		expect(repositories[0].untrackedFiles.text).toBe("new file.txt\n");
		expect(JSON.stringify(repositories[0])).not.toContain("Ignored behavior");
		expect(repositories[1].status).toEqual({ text: "", truncated: false });
		expect(repositories[1].stagedDiff.text).toBe("");
		expect(repositories[1].unstagedDiff.text).toBe("");
		expect(git(first, "rev-parse", "HEAD")).toBe(head);
		expect(readFileSync(path.join(first, ".git/index"))).toEqual(index);
		expect(git(first, "status", "--porcelain=v1", "--untracked-files=all")).toBe(status);
		expect(readFileSync(path.join(first, "feature.txt"), "utf8")).toBe("Final behavior\n");
	});

	it("does not invoke repository-configured diff, textconv, or filesystem monitor programs", async () => {
		const repo = repository();
		const helper = path.join(repo, ".git/inspection-helper");
		writeFileSync(
			helper,
			"#!/bin/sh\ntouch .git/inspection-helper-ran\nprintf 'External program output\\n'\n",
			{ mode: 0o700 },
		);
		writeFileSync(path.join(repo, ".gitattributes"), "feature.txt diff=custom\n");
		git(repo, "add", ".gitattributes");
		git(repo, "commit", "-m", "Configure attributes");
		git(repo, "config", "diff.external", helper);
		git(repo, "config", "diff.custom.textconv", helper);
		git(repo, "config", "core.fsmonitor", helper);
		writeFileSync(path.join(repo, "feature.txt"), "Changed behavior\n");

		const evidence = await prepareRepositoryCommitMessageEvidence(context({ repo }));
		expect(evidence.repositories[0].unstagedDiff.text).toContain("+Changed behavior");
		expect(existsSync(path.join(repo, ".git/inspection-helper-ran"))).toBe(false);
	});

	it("bounds the entire multi-repository checkpoint and marks incomplete diffs", async () => {
		const first = repository();
		const second = repository();
		for (const repo of [first, second])
			writeFileSync(path.join(repo, "feature.txt"), 'Large "quoted" change \\ 😀\n'.repeat(10_000));
		const evidence = await prepareRepositoryCommitMessageEvidence(
			context({ repo_a: first, repo_b: second }),
		);
		expect(Buffer.byteLength(JSON.stringify(evidence), "utf8")).toBeLessThan(65_536);
		expect(evidence.repositories.map(({ key }) => key)).toEqual(["repo_a", "repo_b"]);
		expect(evidence.repositories.every(({ unstagedDiff }) => unstagedDiff.truncated)).toBe(true);
		expect(evidence.repositories.every(({ status }) => status.text.includes("feature.txt"))).toBe(
			true,
		);
	});

	it("fails preparation when a checkout cannot be inspected", async () => {
		const invalid = mkdtempSync(path.join(tmpdir(), "commit-message-invalid-"));
		directories.push(invalid);
		await expect(
			prepareRepositoryCommitMessageEvidence(context({ repo: invalid })),
		).rejects.toThrow("Cannot inspect 'repo': git rev-parse failed");
	});
});
