import { describe, expect, it } from "vitest";
import {
	addLauncherRecentValue,
	buildLauncherRecentValuesStorageKey,
	normalizeLauncherRecentValue,
	normalizeLauncherRecentValues,
	readLauncherRecentValues,
	type StorageLike,
	writeLauncherRecentValue,
} from "./launcher-recent-values.js";

class MemoryStorage implements StorageLike {
	private readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}
}

describe("launcher recent values", () => {
	it("normalizes trimmed unique values and respects the limit", () => {
		expect(
			normalizeLauncherRecentValues(
				["  /tmp/repo-a  ", "/tmp/repo-b", "/tmp/repo-a", "", null, "/tmp/repo-c"],
				2,
			),
		).toEqual(["/tmp/repo-a", "/tmp/repo-b"]);
	});

	it("drops credential-bearing absolute urls but keeps safe repo locators", () => {
		expect(normalizeLauncherRecentValue(" https://token@example.com/org/repo.git ")).toBeNull();
		expect(normalizeLauncherRecentValue("git@github.com:team/repo.git")).toBe(
			"git@github.com:team/repo.git",
		);
		expect(normalizeLauncherRecentValue("/tmp/repo")).toBe("/tmp/repo");
	});

	it("prepends the newest recent value while deduping older matches", () => {
		expect(
			addLauncherRecentValue(["/tmp/repo-a", "/tmp/repo-b", "/tmp/repo-c"], "  /tmp/repo-b  "),
		).toEqual(["/tmp/repo-b", "/tmp/repo-a", "/tmp/repo-c"]);
	});

	it("stores only the newest five values per launcher field", () => {
		const storage = new MemoryStorage();
		for (const value of [
			"/tmp/repo-1",
			"/tmp/repo-2",
			"/tmp/repo-3",
			"/tmp/repo-4",
			"/tmp/repo-5",
			"/tmp/repo-6",
		]) {
			writeLauncherRecentValue(storage, "local_repo_change", "repoLocator", value);
		}

		expect(readLauncherRecentValues(storage, "local_repo_change", "repoLocator")).toEqual([
			"/tmp/repo-6",
			"/tmp/repo-5",
			"/tmp/repo-4",
			"/tmp/repo-3",
			"/tmp/repo-2",
		]);
	});

	it("filters malformed or sensitive values from stored payloads", () => {
		const storage = new MemoryStorage();
		storage.setItem(
			buildLauncherRecentValuesStorageKey("launcher-a", "repoPath"),
			JSON.stringify(["https://token@example.com/private/repo.git", "/tmp/repo-a", "/tmp/repo-a"]),
		);

		expect(readLauncherRecentValues(storage, "launcher-a", "repoPath")).toEqual(["/tmp/repo-a"]);
	});

	it("returns an empty list for malformed stored payloads", () => {
		const storage = new MemoryStorage();
		storage.setItem(buildLauncherRecentValuesStorageKey("launcher-a", "repoPath"), "not json");

		expect(readLauncherRecentValues(storage, "launcher-a", "repoPath")).toEqual([]);
	});

	it("treats storage read and write failures as best-effort misses", () => {
		const readableStorage = new MemoryStorage();
		const key = buildLauncherRecentValuesStorageKey("launcher-a", "repoPath");
		readableStorage.setItem(key, JSON.stringify(["/tmp/existing"]));
		const writeFailingStorage: StorageLike = {
			getItem: readableStorage.getItem.bind(readableStorage),
			setItem() {
				throw new Error("quota exceeded");
			},
			removeItem: readableStorage.removeItem.bind(readableStorage),
		};
		const readFailingStorage: StorageLike = {
			getItem() {
				throw new Error("blocked");
			},
			setItem() {},
		};

		expect(
			writeLauncherRecentValue(writeFailingStorage, "launcher-a", "repoPath", "/tmp/new"),
		).toEqual(["/tmp/existing"]);
		expect(readLauncherRecentValues(readFailingStorage, "launcher-a", "repoPath")).toEqual([]);
	});
});
