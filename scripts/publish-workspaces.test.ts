import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSupportedNodeRange, waitForPublishedWorkspaces } from "./publish-workspaces.mjs";

describe("npm registry propagation", () => {
	const workspaces = [{ name: "@leitwerk-dev/a" }, { name: "@leitwerk-dev/b" }];
	const sha = "a".repeat(40);
	function clock() {
		let elapsed = 0;
		const delays: number[] = [];
		return {
			now: () => elapsed,
			sleep: async (ms: number) => {
				delays.push(ms);
				elapsed += ms;
			},
			log: () => {},
			delays,
			advance: (ms: number) => {
				elapsed += ms;
			},
		};
	}

	it("waits for propagation beyond the old seven-attempt limit", async () => {
		const time = clock();
		const queried: string[][] = [];
		const published = await waitForPublishedWorkspaces(workspaces, sha, {
			...time,
			findPublished: (pending: typeof workspaces, expectedSha: string) => {
				expect(expectedSha).toBe(sha);
				queried.push(pending.map(({ name }) => name));
				return new Set(time.now() >= 5 * 60_000 ? [workspaces[1].name] : [workspaces[0].name]);
			},
		});
		expect([...published]).toEqual(workspaces.map(({ name }) => name));
		expect(time.now()).toBe(5 * 60_000);
		expect(time.delays).toHaveLength(20);
		expect(queried[0]).toEqual(workspaces.map(({ name }) => name));
		expect(
			queried.slice(1).every((names) => names.length === 1 && names[0] === workspaces[1].name),
		).toBe(true);
	});

	it("stops after ten minutes when versions remain unavailable", async () => {
		const time = clock();
		const published = await waitForPublishedWorkspaces(workspaces, sha, {
			...time,
			findPublished: () => new Set(),
		});
		expect(published.size).toBe(0);
		expect(time.now()).toBe(10 * 60_000);
		expect(time.delays).toEqual(Array(40).fill(15_000));
	});

	it("counts lookup time against the window and checks once at the deadline", async () => {
		const time = clock();
		let calls = 0;
		const published = await waitForPublishedWorkspaces(workspaces, sha, {
			...time,
			findPublished: () => {
				calls++;
				if (calls === 1) {
					time.advance(595_000);
					return new Set();
				}
				return new Set(workspaces.map(({ name }) => name));
			},
		});
		expect(time.delays).toEqual([5_000]);
		expect(calls).toBe(2);
		expect(published.size).toBe(2);
	});

	it("returns immediately when all versions are visible", async () => {
		const time = clock();
		await waitForPublishedWorkspaces(workspaces, sha, {
			...time,
			findPublished: () => new Set(workspaces.map(({ name }) => name)),
		});
		expect(time.delays).toEqual([]);
	});

	it("does not retry registry or revision errors", async () => {
		const time = clock();
		await expect(
			waitForPublishedWorkspaces(workspaces, sha, {
				...time,
				findPublished: () => {
					throw new Error("revision mismatch");
				},
			}),
		).rejects.toThrow("revision mismatch");
		expect(time.delays).toEqual([]);
	});
});

describe("published workspace Node engines", () => {
	it.each([
		">=26 <27",
		">=28 <29",
	])("accepts the root's %s range without a hardcoded major", (range) => {
		expect(isSupportedNodeRange(range, range)).toBe(true);
	});

	it.each([
		undefined,
		"",
		">=22",
		">=24",
		">=26",
		">=26 <28",
	])("rejects workspace range %s when the root requires Node 26 only", (range) => {
		expect(isSupportedNodeRange(range, ">=26 <27")).toBe(false);
	});

	it.each([undefined, ""])("rejects a missing root engine contract (%s)", (range) => {
		expect(isSupportedNodeRange(range, range)).toBe(false);
	});

	it("checks the built repository's publishable workspaces through the CLI", () => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const result = spawnSync(process.execPath, ["scripts/publish-workspaces.mjs", "check"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("[publish:check] OK");
	});
});
