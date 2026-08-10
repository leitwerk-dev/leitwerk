import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	calculateConventionalVersion,
	validateLockstepVersions,
	validatePublicationWorkflow,
	validateReleaseContract,
	validateReleaseRegistration,
} from "./release-contract.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("release contract", () => {
	it("keeps every workspace in one linked release group", () => {
		expect(validateReleaseContract(repoRoot)).toEqual([]);
	});

	it("keeps the release workflow manually recoverable", () => {
		const workflow = readFileSync(`${repoRoot}/.github/workflows/release-please.yml`, "utf8");
		expect(workflow.split("\n")).toContain("  workflow_dispatch:");
	});

	it("fails when a newly added workspace has no release component", () => {
		const config = JSON.parse(
			readFileSync(`${repoRoot}/release-please-config.json`, "utf8"),
		) as Record<string, unknown>;
		expect(validateReleaseRegistration(["packages/new-workspace"], config)).toContain(
			"packages/new-workspace: workspace is missing from release-please-config.json",
		);
	});

	it("keeps image builds parallel with validation and gates publication on both", () => {
		expect(
			validatePublicationWorkflow({
				jobs: {
					validate: { needs: "resolve" },
					"inspect-images": { needs: "resolve" },
					"build-images": { needs: ["resolve", "inspect-images"] },
					"merge-images": {
						needs: ["resolve", "validate", "inspect-images", "build-images"],
					},
					publish: { needs: ["resolve", "merge-images"] },
				},
			}),
		).toContain(
			".github/workflows/publish.yml: publish.needs must be [merge-images, resolve, validate], got [merge-images, resolve]",
		);
	});

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
				"Chart.yaml: version must equal '0.4.2'",
				"values.yaml: server image tag must equal '0.4.2'",
				"values.yaml: generic worker image tag must equal '0.4.2'",
			]),
		);
	});
});

describe("pre-1.0 Conventional Commit versioning", () => {
	it("advances the published 0.1.0 baseline to the first integrated patch release", () => {
		expect(calculateConventionalVersion("0.1.0", ["feat: add release automation"])).toBe("0.1.1");
	});

	it.each([
		[["fix: correct timeout"], "0.2.4"],
		[["feat(api): add retries"], "0.2.4"],
		[["feat(api)!: replace request shape"], "0.3.0"],
		[["fix: reject drift\n\nBREAKING CHANGE: lock files are mandatory"], "0.3.0"],
		[["docs: explain releases", "test: cover release workflow", "ci: pin action"], null],
	])("calculates %j as %s", (commits, expected) => {
		expect(calculateConventionalVersion("0.2.3", commits)).toBe(expected);
	});

	it("returns to standard SemVer at 1.0", () => {
		expect(calculateConventionalVersion("1.2.3", ["feat: add capability"])).toBe("1.3.0");
		expect(calculateConventionalVersion("1.2.3", ["feat!: remove API"])).toBe("2.0.0");
	});

	it("honors an explicit Release-As footer", () => {
		expect(calculateConventionalVersion("0.9.9", ["chore: graduate\n\nRelease-As: 1.0.0"])).toBe(
			"1.0.0",
		);
	});
});
