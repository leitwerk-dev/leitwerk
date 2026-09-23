import { describe, expect, it } from "vitest";
import {
	buildLauncherRecentValuesStorageKey,
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
