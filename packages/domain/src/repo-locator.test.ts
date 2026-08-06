import { afterEach, describe, expect, it, vi } from "vitest";
import * as repoLocator from "./repo-locator.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("detectRepoLocatorKind", () => {
	it.each([
		["git@example.com:team/repo.git", "remote_url"],
		["https://example.com/team/repo.git", "remote_url"],
		["file:///tmp/repo", "local_path"],
		["~/src/repo", "local_path"],
		["./repo", "local_path"],
		["../repo", "local_path"],
	] as const)("classifies %s as %s", (value, expectedKind) => {
		expect(repoLocator.detectRepoLocatorKind(value)).toBe(expectedKind);
	});

	it.each(["", "   ", "\n\t"])("returns null for blank input %j", (value) => {
		expect(repoLocator.detectRepoLocatorKind(value)).toBeNull();
	});

	it.each([
		"C:\\Users\\dev\\repo",
		"https://example.com",
		"file://server/share/repo",
		"owner/repo",
		"foo/bar",
		"https:foo/bar",
	])("returns null for unsupported locator %j", (value) => {
		expect(repoLocator.detectRepoLocatorKind(value)).toBeNull();
	});
});

describe("parseRepoLocator", () => {
	it.each([null, undefined, 0, true, {}, []])("returns null for non-string input %j", (value) => {
		expect(repoLocator.parseRepoLocator(value)).toBeNull();
	});

	it("trims the locator before returning it", () => {
		expect(repoLocator.parseRepoLocator("  https://example.com/team/repo.git  ")).toEqual({
			kind: "remote_url",
			value: "https://example.com/team/repo.git",
		});
	});

	it("uses trimmed input for kind detection and returned value", () => {
		const trimmed = "../repo";

		expect(repoLocator.parseRepoLocator(`  ${trimmed}  `)).toEqual({
			kind: repoLocator.detectRepoLocatorKind(trimmed),
			value: trimmed,
		});
	});
});

describe("assertRepoLocator", () => {
	it("throws a helpful error for invalid values", () => {
		expect(() => repoLocator.assertRepoLocator(" ", "component.repoLocator")).toThrowError(
			"component.repoLocator must be a remote URL or local filesystem path",
		);
	});

	it("returns the trimmed locator for valid values", () => {
		expect(repoLocator.assertRepoLocator("  ./repo  ")).toBe("./repo");
	});
});
