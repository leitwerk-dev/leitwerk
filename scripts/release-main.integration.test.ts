import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { parse } from "yaml";
import {
	assertReleaseContext,
	assertSuccessfulMainCi,
	type GitHubRelease,
	prepareReleaseCommit,
	resolveMainRelease,
} from "./release-main.ts";

function git(root: string, ...args: string[]) {
	return execFileSync(
		"git",
		["-C", root, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	).trimEnd();
}

let baselineDirectory: string | undefined;
afterAll(() => {
	if (baselineDirectory) rmSync(baselineDirectory, { recursive: true, force: true });
});

function repositoryCommands(root: string) {
	const write = (filename: string, contents: string) => {
		mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
		writeFileSync(path.join(root, filename), contents);
	};
	const writeJson = (filename: string, contents: unknown) =>
		write(filename, `${JSON.stringify(contents, null, "\t")}\n`);
	const commit = (message: string) => {
		git(root, "add", "--all");
		git(root, "commit", "--allow-empty", "-m", message);
		git(root, "push", "origin", "main");
		return git(root, "rev-parse", "HEAD");
	};
	return { write, writeJson, commit };
}

function createBaseline(directory: string) {
	const root = path.join(directory, "source");
	const remote = path.join(directory, "origin.git");
	mkdirSync(root);
	git(directory, "init", "--bare", remote);
	git(root, "init", "--initial-branch=main");
	git(root, "config", "user.name", "Test Author");
	git(root, "config", "user.email", "author@example.invalid");
	git(root, "remote", "add", "origin", remote);
	const { write, writeJson, commit } = repositoryCommands(root);
	writeJson("package.json", {
		name: "test-root",
		private: true,
		version: "0.4.0",
		workspaces: ["packages/*", "extensions/*"],
	});
	writeJson("packages/a/package.json", {
		name: "@leitwerk-dev/a",
		version: "0.4.0",
		dependencies: { "@leitwerk-dev/b": "0.4.0", external: "^2.0.0" },
	});
	writeJson("extensions/b/package.json", {
		name: "@leitwerk-dev/b",
		version: "0.4.0",
		optionalDependencies: { "@leitwerk-dev/a": "0.4.0" },
		peerDependencies: { "@leitwerk-dev/a": "0.4.0" },
		devDependencies: { "@leitwerk-dev/a": "0.4.0" },
	});
	writeJson("package-lock.json", {
		name: "test-root",
		version: "0.4.0",
		lockfileVersion: 3,
		packages: {
			"": { version: "0.4.0", workspaces: ["packages/*", "extensions/*"] },
			"packages/a": JSON.parse(readFileSync(path.join(root, "packages/a/package.json"), "utf8")),
			"extensions/b": JSON.parse(
				readFileSync(path.join(root, "extensions/b/package.json"), "utf8"),
			),
			"node_modules/external": { version: "2.1.0", integrity: "unchanged" },
			"node_modules/@leitwerk-dev/a": { resolved: "packages/a", link: true },
		},
	});
	write(
		"deploy/kubernetes/helm/leitwerk/Chart.yaml",
		'apiVersion: v2\nname: leitwerk\nversion: 0.4.0\nappVersion: "0.4.0"\n',
	);
	write(
		"deploy/kubernetes/helm/leitwerk/values.yaml",
		'server:\n  image:\n    repository: ghcr.io/leitwerk-dev/leitwerk-server\n    tag: "0.4.0"\nworkerRuntimeProfiles:\n  generic:\n    image: ghcr.io/leitwerk-dev/leitwerk-worker-generic:0.4.0\n',
	);
	write("CHANGELOG.md", "# Changelog\n\n## 0.4.0\n\nHistorical release notes\n");
	write("application.txt", "original application\n");
	commit("feat: baseline");
	git(root, "tag", "v0.4.0");
	git(root, "push", "origin", "--tags");
	commit("feat: historical change that must not be backfilled");
	writeJson("release-policy.json", { baselineTag: "v0.4.0" });
	commit("ci: enable main releases");
}

function fixture() {
	if (!baselineDirectory) {
		baselineDirectory = mkdtempSync(path.join(tmpdir(), "release-main-baseline-"));
		createBaseline(baselineDirectory);
	}
	const directory = mkdtempSync(path.join(tmpdir(), "release-main-test-"));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	// Copy Git objects and refs, never share mutable checkouts or the remote with another case.
	cpSync(baselineDirectory, directory, { recursive: true });
	const root = path.join(directory, "source");
	const remote = path.join(directory, "origin.git");
	git(root, "remote", "set-url", "origin", remote);
	const { write, writeJson, commit } = repositoryCommands(root);
	const releases: GitHubRelease[] = [
		{
			tag_name: "v0.4.0",
			draft: false,
			prerelease: false,
			author: { login: "github-actions[bot]" },
		},
	];
	const creations: { tag: string; notes: string }[] = [];
	const registry = {
		list: () => releases,
		create: (tag: string, notes: string) => {
			creations.push({ tag, notes });
			releases.push({
				tag_name: tag,
				draft: true,
				prerelease: false,
				author: { login: "github-actions[bot]" },
			});
		},
	};
	const validations: string[] = [];
	const resolve = (
		assertValidated = (source: string) => {
			validations.push(source);
		},
	) => resolveMainRelease({ root, registry, assertValidated });
	const publish = () => {
		const release = releases.at(-1);
		if (!release) throw new Error("No release to publish");
		release.draft = false;
	};
	const requireRelease = () => {
		const release = resolve();
		if (!release) throw new Error("Expected a release");
		return release;
	};
	const showJson = (tag: string, filename: string) =>
		JSON.parse(git(root, "show", `${tag}:${filename}`));
	return {
		root,
		remote,
		write,
		writeJson,
		commit,
		releases,
		creations,
		registry,
		validations,
		resolve,
		requireRelease,
		publish,
		showJson,
	};
}

describe("main release queue (real git, local registry boundary)", () => {
	it("skips non-release merges and history before activation without creating artifacts", () => {
		const f = fixture();
		f.commit("docs: document a feature");
		expect(f.resolve()).toBeNull();
		expect(f.creations).toEqual([]);
		expect(git(f.root, "tag", "--list")).toBe("v0.4.0");
	});

	it("versions all workspaces, local dependencies, lock records and chart in a detached signed-off commit", () => {
		const f = fixture();
		f.write("application.txt", "new application\n");
		const source = f.commit(
			"feat: new capability\n\nUseful release details.\n\nSigned-off-by: Test Author <author@example.invalid>",
		);
		const release = f.requireRelease();
		expect(release).toMatchObject({ tag: "v0.4.1", version: "0.4.1", source });
		expect(git(f.root, "rev-parse", "origin/main")).toBe(source);
		expect(git(f.root, "show", "-s", "--format=%P", release.sha)).toBe(source);
		expect(git(f.root, "show", "-s", "--format=%B", release.sha)).toContain(
			"Signed-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
		);
		expect(git(f.root, "status", "--porcelain")).toBe("");
		expect(f.showJson("main", "package.json").version).toBe("0.4.0");
		expect(f.showJson(release.tag, "package.json").version).toBe("0.4.1");
		expect(f.showJson(release.tag, "packages/a/package.json")).toMatchObject({
			version: "0.4.1",
			dependencies: { "@leitwerk-dev/b": "0.4.1", external: "^2.0.0" },
		});
		expect(f.showJson(release.tag, "extensions/b/package.json")).toMatchObject({
			version: "0.4.1",
			optionalDependencies: { "@leitwerk-dev/a": "0.4.1" },
			devDependencies: { "@leitwerk-dev/a": "0.4.1" },
			peerDependencies: { "@leitwerk-dev/a": "0.4.1" },
		});
		const lock = f.showJson(release.tag, "package-lock.json");
		expect(lock.version).toBe("0.4.1");
		for (const workspace of ["", "packages/a", "extensions/b"])
			expect(lock.packages[workspace].version).toBe("0.4.1");
		expect(lock.packages["node_modules/external"]).toEqual({
			version: "2.1.0",
			integrity: "unchanged",
		});
		expect(lock.packages["node_modules/@leitwerk-dev/a"]).toEqual({
			resolved: "packages/a",
			link: true,
		});
		expect(
			parse(git(f.root, "show", `${release.tag}:deploy/kubernetes/helm/leitwerk/Chart.yaml`)),
		).toMatchObject({ version: "0.4.1", appVersion: "0.4.1" });
		expect(
			parse(git(f.root, "show", `${release.tag}:deploy/kubernetes/helm/leitwerk/values.yaml`)),
		).toMatchObject({
			server: { image: { tag: "0.4.1" } },
			workerRuntimeProfiles: {
				generic: { image: "ghcr.io/leitwerk-dev/leitwerk-worker-generic:0.4.1" },
			},
		});
		expect(git(f.root, "show", `${release.tag}:application.txt`)).toBe("new application");
		expect(f.creations[0].notes).toContain("Useful release details.");
		expect(f.creations[0].notes).not.toContain("Signed-off-by");
		expect(git(f.root, "show", `${release.tag}:CHANGELOG.md`)).toContain(
			"Historical release notes",
		);
	});

	it("honors overrides and drains rapid merges numerically, resuming unfinished releases first", () => {
		const f = fixture();
		const first = f.commit("fix: first queued merge\n\nRelease-As: 0.4.9");
		f.commit("ci: non-release merge");
		const second = f.commit("feat: second queued merge");
		const third = f.commit("feat!: third queued merge");
		const initial = f.requireRelease();
		expect(initial).toMatchObject({ tag: "v0.4.9", source: first });
		expect(f.resolve()).toEqual(initial);
		expect(f.creations).toHaveLength(1);
		f.publish();
		expect(f.resolve()).toMatchObject({ tag: "v0.4.10", source: second });
		f.publish();
		expect(f.resolve()).toMatchObject({ tag: "v0.5.0", source: third });
		f.publish();
		expect(f.resolve()).toBeNull();
		const changelog = git(f.root, "show", "v0.5.0:CHANGELOG.md");
		for (const version of ["0.5.0", "0.4.10", "0.4.9", "0.4.0"])
			expect(
				changelog.match(new RegExp(`## ${version.replaceAll(".", "\\.")}`, "gu")),
			).toHaveLength(1);
	}, 30_000);

	it("repairs a crash between tag reservation and draft creation without changing the tag", () => {
		const f = fixture();
		f.commit("fix: recover publication");
		expect(() =>
			resolveMainRelease({
				root: f.root,
				assertValidated: () => {},
				registry: {
					list: f.registry.list,
					create: () => {
						throw new Error("transport failed");
					},
				},
			}),
		).toThrow("transport failed");
		const sha = git(f.root, "rev-parse", "v0.4.1");
		const freshCheckout = path.join(path.dirname(f.root), "retry");
		git(f.root, "clone", "--branch", "main", f.remote, freshCheckout);
		expect(
			resolveMainRelease({ root: freshCheckout, registry: f.registry, assertValidated: () => {} }),
		).toMatchObject({
			tag: "v0.4.1",
			sha,
		});
		expect(f.creations).toHaveLength(1);
	});

	it("discovers newly added workspaces without maintaining a release component list", () => {
		const f = fixture();
		f.writeJson("extensions/new/package.json", {
			name: "@leitwerk-dev/new",
			version: "0.4.0",
			dependencies: { "@leitwerk-dev/a": "0.4.0" },
		});
		const lock = JSON.parse(readFileSync(path.join(f.root, "package-lock.json"), "utf8"));
		lock.packages["extensions/new"] = {
			version: "0.4.0",
			dependencies: { "@leitwerk-dev/a": "0.4.0" },
		};
		f.writeJson("package-lock.json", lock);
		f.commit("feat: new extension");
		f.resolve();
		expect(f.showJson("v0.4.1", "extensions/new/package.json")).toMatchObject({
			version: "0.4.1",
			dependencies: { "@leitwerk-dev/a": "0.4.1" },
		});
		expect(f.showJson("v0.4.1", "package-lock.json").packages["extensions/new"].version).toBe(
			"0.4.1",
		);
	});

	it("never republishes a completed release or accepts a manually selected version", () => {
		const f = fixture();
		f.commit("fix: first");
		f.requireRelease();
		f.publish();
		expect(f.resolve()).toBeNull();
		f.commit("fix: second");
		expect(f.requireRelease().tag).toBe("v0.4.2");
	});

	it("requires CI for the exact source and current tooling before reserving any artifacts", () => {
		const f = fixture();
		const source = f.commit("fix: first");
		const tooling = f.commit("ci: repair publication");
		expect(() =>
			f.resolve((sha) => {
				if (sha === tooling) throw new Error("CI pending");
			}),
		).toThrow("CI pending");
		expect(git(f.root, "tag", "--list")).toBe("v0.4.0");
		expect(f.creations).toEqual([]);
		f.requireRelease();
		expect(f.validations).toEqual([source, tooling]);
		const resumed: string[] = [];
		f.resolve((sha) => {
			resumed.push(sha);
		});
		expect(resumed).toEqual([source, tooling]);
	});

	it("does not let a later invalid override prevent recovery of a reserved release", () => {
		const f = fixture();
		f.commit("fix: valid");
		const first = f.resolve();
		f.commit("chore: invalid\n\nRelease-As: 0.1.0");
		expect(f.resolve()).toEqual(first);
		f.publish();
		expect(() => f.resolve()).toThrow("Release-As must increase");
		expect(f.creations).toHaveLength(1);
	});

	it("rejects a tag pointing at ordinary main code rather than a generated release commit", () => {
		const f = fixture();
		f.commit("fix: a change");
		git(f.root, "tag", "v0.4.1");
		git(f.root, "push", "origin", "--tags");
		expect(() => f.resolve()).toThrow("does not match its main source");
		expect(f.creations).toEqual([]);
	});

	it("rejects modified release contents even when the message and main parent match", () => {
		const f = fixture();
		f.commit("fix: a change");
		const release = f.requireRelease();
		f.write("application.txt", "unexpected code\n");
		git(f.root, "add", "--all");
		const tree = git(f.root, "write-tree");
		const message = git(f.root, "show", "-s", "--format=%B", release.sha);
		const modified = git(f.root, "commit-tree", tree, "-p", release.source, "-m", message);
		git(f.root, "tag", "--force", release.tag, modified);
		git(f.root, "push", "--force", "origin", `refs/tags/${release.tag}`);
		expect(() => f.resolve()).toThrow("contents differ from the verified main source");
		expect(f.creations).toHaveLength(1);
	});

	it("rejects skipped merges and unfinished releases followed by newer reservations", () => {
		const f = fixture();
		f.commit("fix: first");
		const first = f.requireRelease();
		const source = f.commit("fix: second");
		const second = { source, version: "0.4.2", tag: "v0.4.2", previousTag: "v0.4.1" };
		const sha = prepareReleaseCommit(f.root, second);
		git(f.root, "tag", second.tag, sha);
		git(f.root, "push", "origin", "--tags");
		expect(() => f.resolve()).toThrow(`Unfinished release precedes newer tags: ${first.tag}`);
		git(f.root, "tag", "--delete", first.tag);
		git(f.root, "push", "origin", `:refs/tags/${first.tag}`);
		f.releases.splice(1);
		expect(() => f.resolve()).toThrow("Unexpected release tag or skipped merge");
	});

	it.each([
		"baseline draft",
		"human release",
		"prerelease",
		"missing tag",
		"baseline changed",
	])("fails closed for %s before allocating another version", (failure) => {
		const f = fixture();
		f.commit("fix: a change");
		if (failure === "baseline draft") f.releases[0].draft = true;
		if (failure === "human release") f.releases[0].author.login = "maintainer";
		if (failure === "prerelease") f.releases[0].prerelease = true;
		if (failure === "missing tag") f.releases.push({ ...f.releases[0], tag_name: "v0.4.1" });
		if (failure === "baseline changed") {
			f.writeJson("release-policy.json", { baselineTag: "v0.3.0" });
			f.commit("ci: reset baseline");
			f.releases.push({ ...f.releases[0], tag_name: "v0.3.0" });
		}
		expect(() => f.resolve()).toThrow();
		expect(f.creations).toEqual([]);
	});
});

describe("publication workflow trust boundary", () => {
	it.each(["schedule", "workflow_run"])("accepts automatic %s only without overrides", (event) => {
		const env = { GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: event };
		expect(() => assertReleaseContext(env)).not.toThrow();
		expect(() => assertReleaseContext({ ...env, RELEASE_TAG: "v0.4.1" })).toThrow(
			"without overrides",
		);
	});

	it("requires a successful main push CI for the exact release revision", () => {
		const source = "a".repeat(40);
		const run = { head_sha: source, head_branch: "main", event: "push", conclusion: "success" };
		expect(() => assertSuccessfulMainCi([run], source)).not.toThrow();
		for (const other of [
			{ ...run, head_sha: "b".repeat(40) },
			{ ...run, head_branch: "feature" },
			{ ...run, event: "pull_request" },
			{ ...run, conclusion: "failure" },
			{ ...run, conclusion: null },
		]) {
			expect(() => assertSuccessfulMainCi([other], source)).toThrow("Main CI has not succeeded");
		}
		expect(() => assertSuccessfulMainCi([], source)).toThrow("Main CI has not succeeded");
	});

	it.each([
		["refs/heads/feature", "workflow_dispatch"],
		["refs/tags/v0.4.1", "workflow_dispatch"],
		["refs/heads/main", "pull_request"],
		["refs/heads/main", "push"],
		["refs/heads/main", "workflow_dispatch"],
		["refs/heads/feature", "schedule"],
	])("rejects %s / %s before accessing git or GitHub", (ref, event) => {
		expect(() => assertReleaseContext({ GITHUB_REF: ref, GITHUB_EVENT_NAME: event })).toThrow(
			"Publication must run from main",
		);
	});

	it("keeps the stable npm workflow identity and drains releases serially on main", () => {
		const workflow = parse(
			readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8"),
		);
		expect(workflow.on.push).toBeUndefined();
		expect(workflow.on.workflow_dispatch).toBeUndefined();
		expect(workflow.on.workflow_run.workflows).toEqual(["CI"]);
		expect(workflow.on.workflow_run.branches).toEqual(["main"]);
		expect(workflow.on.schedule).toHaveLength(1);
		expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
		expect(workflow.concurrency.group).not.toContain("${{");
		expect(workflow.jobs.npm.environment).toBe("npm-publish");
		expect(workflow.jobs["merge-images"].needs).toEqual(
			expect.arrayContaining(["validate", "build-images"]),
		);
		expect(workflow.jobs.publish.needs).toEqual(
			expect.arrayContaining(["validate", "merge-images", "npm"]),
		);
	});
});
