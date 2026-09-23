import { describe, expect, it } from "vitest";
import * as repoLocator from "./repo-locator.js";

describe("detectRepoLocatorKind", () => {
	it.each([
		["git@example.com:team/repo.git", "remote_url"],
		["https://example.com/team/repo.git", "remote_url"],
		["file:///tmp/repo", "local_path"],
		["~/src/repo", "local_path"],
		["./repo", "local_path"],
		["../repo", "local_path"],
		["/tmp/repo", "local_path"],
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
		"not a locator",
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

	it.each([
		["https://example.com/team/repo.git", "remote_url"],
		["../repo", "local_path"],
	] as const)("trims %s and classifies it as %s", (value, kind) => {
		expect(repoLocator.parseRepoLocator(`  ${value}  `)).toEqual({
			kind,
			value,
		});
	});
});

describe("assertRepoLocator", () => {
	it("throws a helpful error for invalid values", () => {
		expect(() => repoLocator.assertRepoLocator(" ", "component.repoLocator")).toThrowError(
			/component\.repoLocator/,
		);
	});

	it("returns the trimmed locator for valid values", () => {
		expect(repoLocator.assertRepoLocator("  ./repo  ")).toBe("./repo");
	});
});
