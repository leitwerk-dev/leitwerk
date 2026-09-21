import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { finalizeRelease } from "./finalize-release.mjs";

const directories: string[] = [];
const sha = "a".repeat(40);
const tag = "v0.2.1";
const repository = "leitwerk-dev/leitwerk";

function fixture() {
	const directory = mkdtempSync(path.join(tmpdir(), "finalize-release-test-"));
	directories.push(directory);
	const files = [
		path.join(directory, "leitwerk-0.2.1.tgz"),
		path.join(directory, "leitwerk-base.lock.yaml"),
	];
	writeFileSync(files[0], "verified chart bytes");
	writeFileSync(files[1], `public_git_sha: ${sha}\n`);
	return { repository, tag, sha, files };
}

class FakeGitHub {
	draft = true;
	id = 123;
	author = "github-actions[bot]";
	commit = sha;
	assets = new Map<string, Buffer>();
	writes: string[] = [];
	failUpload = "";
	moveTagAfterUpload = false;
	run = (args: string[]) => {
		if (args[0] === "api" && args[1].includes("/commits/")) return this.commit;
		if (args[0] === "api" && args[1] === "--method") {
			expect(args).toEqual([
				"api",
				"--method",
				"PATCH",
				`repos/${repository}/releases/${this.id}`,
				"-F",
				"draft=false",
			]);
			this.writes.push("publish");
			this.draft = false;
			return "";
		}
		expect(args[0]).toBe("release");
		expect(args[2]).toBe(tag);
		expect(args[args.indexOf("--repo") + 1]).toBe(repository);
		switch (args[1]) {
			case "view":
				return JSON.stringify({
					databaseId: this.id,
					tagName: tag,
					isDraft: this.draft,
					isPrerelease: false,
					author: { login: this.author },
					assets: [...this.assets.keys()].map((name) => ({ name })),
				});
			case "download": {
				const name = args[args.indexOf("--pattern") + 1];
				const directory = args[args.indexOf("--dir") + 1];
				writeFileSync(path.join(directory, name), this.assets.get(name) ?? "missing");
				return "";
			}
			case "upload": {
				const file = args[3];
				const name = path.basename(file);
				if (name === this.failUpload) throw new Error("Upload failed");
				expect(this.assets.has(name)).toBe(false);
				expect(args).not.toContain("--clobber");
				this.assets.set(name, readFileSync(file));
				this.writes.push(`upload:${name}`);
				if (this.moveTagAfterUpload) this.commit = "b".repeat(40);
				return "";
			}
			default:
				throw new Error(`Unexpected gh command: ${args.join(" ")}`);
		}
	};
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("immutable release finalization", () => {
	it("uploads both assets before publishing the draft", () => {
		const input = fixture();
		const github = new FakeGitHub();
		finalizeRelease(input, github.run);
		expect(github.writes).toEqual([
			"upload:leitwerk-0.2.1.tgz",
			"upload:leitwerk-base.lock.yaml",
			"publish",
		]);
		expect(github.draft).toBe(false);
	});

	it("resumes partial uploads without replacing assets", () => {
		const input = fixture();
		const github = new FakeGitHub();
		github.failUpload = "leitwerk-base.lock.yaml";
		expect(() => finalizeRelease(input, github.run)).toThrow("Upload failed");
		expect(github.draft).toBe(true);
		github.failUpload = "";
		finalizeRelease(input, github.run);
		expect(github.writes).toEqual([
			"upload:leitwerk-0.2.1.tgz",
			"upload:leitwerk-base.lock.yaml",
			"publish",
		]);
	});

	it("verifies an already published release without any writes", () => {
		const input = fixture();
		const github = new FakeGitHub();
		finalizeRelease(input, github.run);
		github.writes = [];
		finalizeRelease(input, github.run);
		expect(github.writes).toEqual([]);
	});

	it("rejects incomplete published releases without attempting to change them", () => {
		const github = new FakeGitHub();
		github.draft = false;
		expect(() => finalizeRelease(fixture(), github.run)).toThrow("create a new version");
		expect(github.writes).toEqual([]);
	});

	it("rejects conflicting existing contents before uploading missing assets", () => {
		const github = new FakeGitHub();
		github.assets.set("leitwerk-base.lock.yaml", Buffer.from("different release coordinates"));
		expect(() => finalizeRelease(fixture(), github.run)).toThrow("differs from validated contents");
		expect(github.writes).toEqual([]);
	});

	it("rejects a moved tag before any writes", () => {
		const github = new FakeGitHub();
		github.commit = "b".repeat(40);
		expect(() => finalizeRelease(fixture(), github.run)).toThrow("tag moved");
		expect(github.writes).toEqual([]);
	});

	it("rechecks the tag before making the release immutable", () => {
		const github = new FakeGitHub();
		github.moveTagAfterUpload = true;
		expect(() => finalizeRelease(fixture(), github.run)).toThrow("tag moved");
		expect(github.draft).toBe(true);
		expect(github.writes).not.toContain("publish");
	});

	it("rejects manually created releases", () => {
		const github = new FakeGitHub();
		github.author = "maintainer";
		expect(() => finalizeRelease(fixture(), github.run)).toThrow("Release Please");
		expect(github.writes).toEqual([]);
	});

	it("runs trusted finalization only after public artifact verification and retains recovery artifacts", () => {
		const workflow = parse(
			readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8"),
		);
		const steps = workflow.jobs.publish.steps;
		const finalIndex = steps.findIndex(
			(step: { run?: string }) => step.run === "node .release-tooling/scripts/finalize-release.mjs",
		);
		const verifyIndex = steps.findIndex(
			(step: { name: string }) =>
				step.name === "Verify anonymous reads and multi-architecture manifests",
		);
		expect(finalIndex).toBeGreaterThan(verifyIndex);
		expect(steps[finalIndex - 1].with).toMatchObject({
			ref: `\${{ github.sha }}`,
			path: ".release-tooling",
			"persist-credentials": false,
		});
		const upload = steps.find(
			(step: { name: string }) => step.name === "Upload release artifacts to workflow run",
		);
		expect(upload.if).toBe(`\${{ always() && steps.coordinates.outcome == 'success' }}`);
		expect(
			steps.find((step: { name: string }) => step.name === "Record immutable release coordinates")
				.id,
		).toBe("coordinates");
		expect(JSON.stringify(steps)).not.toContain("--clobber");
	});
});
