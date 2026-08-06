import { describe, expect, it } from "vitest";
import {
	addLauncherRecentValue,
	normalizeLauncherRecentValue,
	normalizeLauncherRecentValues,
} from "./launcher-recent-values.js";

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
});
