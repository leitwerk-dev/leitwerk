import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isSupportedNodeRange,
	publishWorkspaces,
	waitForPublishedWorkspaces,
} from "./publish-workspaces.mjs";

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

describe("npm publication recovery", () => {
	const workspaces = ["a", "b"].map((name) => ({
		name: `@leitwerk-dev/${name}`,
		packageJson: { version: "0.4.1" },
	}));
	const sha = "a".repeat(40);
	const conflict = {
		status: 1,
		stdout: "",
		stderr: "npm error code TLOG_CREATE_ENTRY_ERROR\n409 equivalent entry already exists",
	};
	const ok = { status: 0, stdout: "", stderr: "" };
	const defaults = {
		log: () => {},
		report: () => {},
		sleep: async () => {},
		findPublished: () => new Set<string>(),
	};

	it("retries the affected package independently without disabling provenance", async () => {
		const calls: string[][] = [];
		const delays: number[] = [];
		await publishWorkspaces("/source", workspaces, sha, {
			...defaults,
			run: (args: string[]) => {
				calls.push(args);
				return calls.length === 1 ? conflict : ok;
			},
			sleep: async (ms: number) => {
				delays.push(ms);
			},
		});
		expect(calls).toEqual([
			["publish", "--workspace", "@leitwerk-dev/a", "--access", "public"],
			["publish", "--workspace", "@leitwerk-dev/a", "--access", "public"],
			["publish", "--workspace", "@leitwerk-dev/b", "--access", "public"],
		]);
		expect(delays).toEqual([15_000]);
	});

	it("checks registry identity after a failed response and skips an accepted version", async () => {
		let calls = 0;
		await publishWorkspaces("/source", workspaces, sha, {
			...defaults,
			run: () => {
				calls++;
				return conflict;
			},
			findPublished: (pending: typeof workspaces, expectedSha: string) => {
				expect(expectedSha).toBe(sha);
				return new Set(pending.map(({ name }) => name));
			},
		});
		expect(calls).toBe(2);
	});

	it.each([
		"E403",
		"TLOG_CREATE_ENTRY_ERROR",
	])("stops after bounded attempts for %s without publishing newer packages", async (code) => {
		let calls = 0;
		const records: unknown[] = [];
		await expect(
			publishWorkspaces("/source", workspaces, sha, {
				...defaults,
				run: () => {
					calls++;
					return { ...conflict, stderr: `npm error code ${code}\n409 secret-auth-url` };
				},
				report: (record: unknown) => {
					records.push(record);
				},
			}),
		).rejects.toThrow(`npm publication failed for @leitwerk-dev/a@0.4.1: ${code}`);
		expect(calls).toBe(code === "E403" ? 1 : 3);
		expect(records).toEqual(
			Array.from({ length: calls }, (_, index) => ({
				package: "@leitwerk-dev/a@0.4.1",
				attempt: index + 1,
				status: 1,
				code,
			})),
		);
	});

	it("rejects conflicting registry identity without retrying", async () => {
		await expect(
			publishWorkspaces("/source", workspaces, sha, {
				...defaults,
				run: () => conflict,
				findPublished: () => {
					throw new Error("different release identity");
				},
			}),
		).rejects.toThrow("different release identity");
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

	it.each(["check", "preflight", "publish", "verify"])("validates the %s command", (mode) => {
		const root = fileURLToPath(new URL("../", import.meta.url));
		const result = spawnSync(process.execPath, ["scripts/publish-workspaces.mjs", mode], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, RELEASE_TAG: "v0.0.0" },
		});
		expect(result.status).toBe(mode === "check" ? 0 : 1);
		expect(result.stdout + result.stderr).toContain(
			mode === "check" ? "[publish:check] OK" : "RELEASE_TAG must equal",
		);
	});
});
