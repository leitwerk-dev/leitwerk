import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	collectPages,
	orderStack,
	readCheckout,
	readValidation,
	unresolvedReviewThreads,
	validateCheckout,
} from "./review-stack.mjs";

const repository = "example/project";
const directories: string[] = [];

function pull(number: number, base: string, head: string, state = "OPEN") {
	return {
		number,
		state,
		baseRefName: base,
		baseRefOid: `${base}-sha`,
		headRefName: head,
		headRefOid: `${head}-sha`,
		headRepository: { nameWithOwner: repository },
		url: `https://github.com/${repository}/pull/${number}`,
	};
}

function git(cwd: string, args: string[]) {
	return execFileSync(
		"git",
		[
			"-c",
			"user.name=Stack Review Test",
			"-c",
			"user.email=stack-review@example.com",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"core.hooksPath=/dev/null",
			...args,
		],
		{ cwd, encoding: "utf8" },
	).trim();
}

async function fixture() {
	const cwd = await mkdtemp(path.join(tmpdir(), "leitwerk-review-stack-"));
	directories.push(cwd);
	git(cwd, ["init", "-q"]);
	await writeFile(path.join(cwd, "tracked.txt"), "original\n");
	git(cwd, ["add", "tracked.txt"]);
	git(cwd, ["commit", "-q", "-s", "-m", "test: create fixture"]);
	return cwd;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("stack discovery", () => {
	it("keeps answered, outdated decisions open until resolved without classifying guide notes", () => {
		const decision = {
			id: "decision",
			isResolved: false,
			isOutdated: true,
			first: { nodes: [{ body: "<!-- stack-review:decision -->\nRetain data?" }] },
			latest: { nodes: [{ body: "Yes, retain it." }] },
		};
		const guide = {
			...decision,
			id: "guide",
			first: { nodes: [{ body: "Review guide: this code retains Docker data." }] },
		};
		expect(
			unresolvedReviewThreads([decision, guide, { ...decision, isResolved: true }]).map(
				(thread) => ({ id: thread.id, isDecision: thread.isDecision }),
			),
		).toEqual([
			{ id: "decision", isDecision: true },
			{ id: "guide", isDecision: false },
		]);
	});

	it("orders a merged stack and excludes forks and older uses of a branch", () => {
		const top = pull(4, "third", "fourth", "MERGED");
		const first = pull(1, "main", "first", "MERGED");
		const second = pull(2, "first", "second", "MERGED");
		const third = pull(3, "second", "third", "MERGED");
		const reused = { ...pull(5, "main", "second"), headRefOid: "another-sha" };
		const fork = {
			...first,
			number: 6,
			headRepository: { nameWithOwner: "someone/fork" },
		};
		expect(
			orderStack([top, fork, reused, third, first, second], 4, repository, "main").map(
				(pr) => pr.number,
			),
		).toEqual([1, 2, 3, 4]);
	});

	it("reports ambiguous ancestry instead of guessing between PRs", () => {
		expect(() =>
			orderStack(
				[pull(1, "main", "first"), pull(2, "release", "first"), pull(3, "first", "second")],
				3,
				repository,
				"main",
			),
		).toThrow("Ambiguous parent");
	});

	it("rejects cycles instead of repeatedly visiting the same branches", () => {
		expect(() =>
			orderStack([pull(1, "second", "first"), pull(2, "first", "second")], 2, repository, "main"),
		).toThrow("cycle");
	});

	it("includes decisions after the first page and rejects a stalled cursor", async () => {
		const nodes = await collectPages(async (cursor) =>
			cursor === null
				? {
						nodes: Array.from({ length: 100 }, (_, id) => ({ id, isResolved: true })),
						pageInfo: { hasNextPage: true, endCursor: "next" },
					}
				: {
						nodes: [{ id: 100, isResolved: false }],
						pageInfo: { hasNextPage: false, endCursor: null },
					},
		);
		expect(nodes.filter((node) => !node.isResolved)).toEqual([{ id: 100, isResolved: false }]);
		await expect(
			collectPages(async () => ({
				nodes: [],
				pageInfo: { hasNextPage: true, endCursor: "same" },
			})),
		).rejects.toThrow("pagination did not advance");
	});
});

describe("local validation evidence", () => {
	it("reports renamed and untracked files with spaces and newlines intact", async () => {
		const cwd = await fixture();
		git(cwd, ["mv", "tracked.txt", "renamed\nfile.txt"]);
		await writeFile(path.join(cwd, "untracked file.txt"), "pending\n");
		expect((await readCheckout(cwd)).dirtyFiles).toEqual([
			{ status: "R ", path: "renamed\nfile.txt", from: "tracked.txt" },
			{ status: "??", path: "untracked file.txt" },
		]);
	});

	it("refuses to attribute uncommitted changes to HEAD", async () => {
		const cwd = await fixture();
		await writeFile(path.join(cwd, "untracked.txt"), "pending\n");
		let started = false;
		await expect(
			validateCheckout(cwd, async () => {
				started = true;
				return 0;
			}),
		).rejects.toThrow("clean checkout");
		expect(started).toBe(false);
	});

	it("records a clean success only for its SHA and supersedes it when a rerun fails", async () => {
		const cwd = await fixture();
		const checkout = await readCheckout(cwd);
		expect(await validateCheckout(cwd, async () => 0)).toMatchObject({
			status: "passed",
			exitCode: 0,
		});
		expect(await readValidation(checkout, checkout.head)).toMatchObject({
			sha: checkout.head,
			command: "npm run test:full",
			status: "passed",
		});
		expect(await readValidation(checkout, "a".repeat(40))).toBeNull();
		expect(
			await validateCheckout(cwd, async () => {
				expect(await readValidation(checkout, checkout.head)).toMatchObject({ status: "running" });
				return 1;
			}),
		).toMatchObject({ status: "failed", exitCode: 1 });
		expect(await readValidation(checkout, checkout.head)).toMatchObject({ status: "failed" });
		expect((await readCheckout(cwd)).dirtyFiles).toEqual([]);
	});

	it.each([
		"dirty files",
		"changed HEAD",
	])("invalidates a successful run with %s", async (change) => {
		const cwd = await fixture();
		const checkout = await readCheckout(cwd);
		const result = await validateCheckout(cwd, async () => {
			await writeFile(path.join(cwd, "tracked.txt"), "changed during validation\n");
			if (change === "changed HEAD") {
				git(cwd, ["commit", "-q", "-s", "-am", "test: move fixture HEAD"]);
			}
			return 0;
		});
		expect(result).toMatchObject({ status: "invalidated", exitCode: 1 });
		expect(await readValidation(checkout, checkout.head)).toMatchObject({ status: "invalidated" });
	});
});
