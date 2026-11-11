import { describe, expect, it } from "vitest";
import { calculateConventionalVersion, validateLockstepVersions } from "./release-contract.js";

describe("release contract", () => {
	it("detects drift across manifests, lockfile, chart metadata, and image tags", () => {
		const errors = validateLockstepVersions({
			rootManifest: { version: "0.4.2" },
			workspaces: [
				{
					path: "packages/a",
					manifest: {
						name: "@leitwerk-dev/a",
						version: "0.4.1",
						dependencies: { "@leitwerk-dev/b": "^0.4.0" },
					},
				},
				{ path: "packages/b", manifest: { name: "@leitwerk-dev/b", version: "0.4.2" } },
			],
			packageLock: {
				version: "0.4.1",
				packages: {
					"": { version: "0.4.1" },
					"packages/a": {
						version: "0.4.1",
						dependencies: { "@leitwerk-dev/b": "^0.4.0" },
					},
					"packages/b": { version: "0.4.2" },
				},
			},
			chart: { version: "0.4.1", appVersion: "0.4.1" },
			chartValues: {
				server: { image: { repository: "example.invalid/server", tag: "edge" } },
				workerRuntimeProfiles: { generic: { image: "example.invalid/worker:edge" } },
			},
		});
		expect(errors).toEqual(
			expect.arrayContaining([
				"packages/a/package.json: version '0.4.1' must equal '0.4.2'",
				"packages/a/package.json: dependencies.@leitwerk-dev/b must be exactly '0.4.2'",
				"package-lock.json: version must equal '0.4.2'",
				"package-lock.json packages[\"packages/a\"]: version '0.4.1' must equal '0.4.2'",
				"package-lock.json packages[\"packages/a\"]: dependencies.@leitwerk-dev/b must be exactly '0.4.2'",
				"Chart.yaml: version must equal '0.4.2'",
				"values.yaml: server image tag must equal '0.4.2'",
				"values.yaml: generic worker image tag must equal '0.4.2'",
			]),
		);
	});
});

describe("pre-1.0 Conventional Commit versioning", () => {
	it.each([
		["fix: correct timeout", "0.2.4"],
		["feat(api): add retries", "0.2.4"],
		["feat(api)!: replace request shape", "0.3.0"],
		["fix: reject drift\n\nBREAKING CHANGE: lock files are mandatory", "0.3.0"],
		["refactor!: replace an API", "0.3.0"],
		["chore: replace an API\n\nBREAKING-CHANGE: old API removed", "0.3.0"],
		["docs: explain releases", null],
		["test: cover release workflow", null],
		["ci: pin action", "0.2.4"],
	])("calculates %j as %s", (commit, expected) => {
		expect(calculateConventionalVersion("0.2.3", commit)).toBe(expected);
	});

	it.each([
		"fix",
		"ci",
		"build",
		"chore",
		"refactor",
		"perf",
		"revert",
	])("releases a patch for %s with or without a scope", (type) => {
		for (const scope of ["", "(deps)"]) {
			const commit = `${type}${scope}: update dependencies`;
			expect(calculateConventionalVersion("0.4.0", commit)).toBe("0.4.1");
			expect(calculateConventionalVersion("1.2.3", commit)).toBe("1.2.4");
		}
	});

	it.each(["docs", "test"])("does not release for ordinary %s changes", (type) => {
		for (const scope of ["", "(release)"]) {
			const commit = `${type}${scope}: clarify release behavior`;
			expect(calculateConventionalVersion("0.4.0", commit)).toBeNull();
			expect(calculateConventionalVersion("1.2.3", commit)).toBeNull();
		}
	});

	it("returns to standard SemVer at 1.0", () => {
		expect(calculateConventionalVersion("1.2.3", "feat: add capability")).toBe("1.3.0");
		expect(calculateConventionalVersion("1.2.3", "feat!: remove API")).toBe("2.0.0");
	});

	it.each([
		"0.9.9",
		"0.9.8",
		"1.0.0-rc.1",
		"1.0.0+build",
		"01.0.0",
		"invalid",
	])("rejects non-increasing or non-stable Release-As: %s", (version) => {
		expect(() =>
			calculateConventionalVersion("0.9.9", `chore: override\n\nRelease-As: ${version}`),
		).toThrow();
	});

	it.each(["1.2.3-rc.1", "1.2", "01.2.3"])("rejects invalid current version %s", (version) => {
		expect(() => calculateConventionalVersion(version, "fix: something")).toThrow();
	});

	it("honors an explicit Release-As footer", () => {
		expect(calculateConventionalVersion("0.9.9", "chore: graduate\n\nRelease-As: 1.0.0")).toBe(
			"1.0.0",
		);
	});
});
