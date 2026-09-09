import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";

describe("launcher recent value repository", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps newest unique values per launcher field", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
		const repos = createAllRepos(createInMemoryDatabase());
		for (const value of ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d"]) {
			repos.launcherRecentValues.recordValue({
				launcherId: "launcher-a",
				fieldId: "repoLocator",
				value,
				limit: 3,
			});
			vi.advanceTimersByTime(1_000);
		}
		const original = repos.launcherRecentValues.listByLauncher("launcher-a")[2];
		const replay = repos.launcherRecentValues.recordValue({
			launcherId: "launcher-a",
			fieldId: "repoLocator",
			value: "/tmp/b",
			limit: 3,
		});
		expect(replay).toEqual({ ...original, updatedAt: new Date().toISOString() });

		expect(
			repos.launcherRecentValues.listByLauncher("launcher-a").map((entry) => entry.value),
		).toEqual(["/tmp/b", "/tmp/d", "/tmp/c"]);
	});
});
