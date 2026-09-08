import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	candidateManifest,
	candidateVersion,
	prepareCandidate,
	publishCandidate,
	resolveCandidate,
	validateCandidatePull,
	validateExistingCandidate,
	validateNextTag,
	verifyCandidateArchives,
} from "./release-candidate.mjs";

const directories: string[] = [];
const sha = "a".repeat(40);
const version = "0.2.0-rc.123";
const repository = "leitwerk-dev/leitwerk";
const catalog = [
	{ name: "@leitwerk-dev/a", directory: "packages/a" },
	{ name: "@leitwerk-dev/b", directory: "packages/b" },
];
const names = new Set(catalog.map((entry) => entry.name));
function temporary() {
	const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-rc-test-"));
	directories.push(directory);
	return directory;
}
function json(filename: string, value: unknown) {
	mkdirSync(path.dirname(filename), { recursive: true });
	writeFileSync(filename, `${JSON.stringify(value)}\n`);
}
function pull() {
	return {
		state: "open",
		draft: false,
		merged_at: null as string | null,
		user: { login: "github-actions[bot]" },
		head: { ref: "release-please--branches--main", sha, repo: { full_name: repository } },
		base: { ref: "main", repo: { full_name: repository } },
	};
}
function packageManifest(name = catalog[0].name) {
	return {
		name,
		version: "0.2.0",
		files: ["index.js"],
		dependencies: { "@leitwerk-dev/b": "0.2.0", yaml: "2.8.3" },
		optionalDependencies: { "@leitwerk-dev/b": "0.2.0" },
		peerDependencies: { "@leitwerk-dev/b": "0.2.0" },
		devDependencies: { "@leitwerk-dev/b": "0.2.0" },
		scripts: { prepack: "touch lifecycle-ran", prepare: "touch lifecycle-ran" },
		publishConfig: { registry: "https://unexpected.invalid", tag: "latest" },
	};
}
function archives() {
	const directory = temporary();
	for (const entry of catalog) {
		const source = temporary();
		json(
			path.join(source, "package/package.json"),
			candidateManifest(packageManifest(entry.name), { version, sha, names }),
		);
		execFileSync("tar", [
			"-czf",
			path.join(directory, `${entry.name.slice(1).replace("/", "-")}-${version}.tgz`),
			"-C",
			source,
			"package",
		]);
	}
	return directory;
}
async function githubFixture(overrides: Record<string, unknown> = {}) {
	const routes: Record<string, unknown> = {
		"pulls/40": pull(),
		[`compare/${"b".repeat(40)}...${sha}`]: { status: "ahead" },
		[`contents/package.json?ref=${sha}`]: {
			encoding: "base64",
			content: Buffer.from(JSON.stringify({ version: "0.2.0" })).toString("base64"),
		},
		...overrides,
	};
	const server = createServer((request, response) => {
		const route = request.url?.replace(`/repos/${repository}/`, "") ?? "";
		response.writeHead(route in routes ? 200 : 404, { "Content-Type": "application/json" });
		response.end(JSON.stringify(routes[route] ?? {}));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		env: {
			GITHUB_REF: "refs/heads/main",
			GITHUB_EVENT_NAME: "workflow_dispatch",
			GITHUB_SHA: "b".repeat(40),
			GITHUB_REPOSITORY: repository,
			GITHUB_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
			GH_TOKEN: "fixture-token",
			GITHUB_RUN_ID: "123",
			RELEASE_PR: "40",
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("release candidate identity", () => {
	it("derives a unique immutable version without changing the stable version", () => {
		expect(candidateVersion("0.2.0", "123")).toBe(version);
		expect(candidateVersion("0.2.0", "124")).toBe("0.2.0-rc.124");
	});
	it.each([
		"0.2.0-rc.1",
		"0.2.0+build",
		"v0.2.0",
		"00.2.0",
		"latest",
	])("rejects invalid base %s", (base) => {
		expect(() => candidateVersion(base, "123")).toThrow();
	});
	it.each(["0", "01", "-1", "../x", "123\n", ""])("rejects invalid run ID %s", (id) => {
		expect(() => candidateVersion("0.2.0", id)).toThrow();
	});
	it("accepts only the pinned open release PR", () => {
		expect(validateCandidatePull(pull(), repository, sha)).toBe(sha);
		expect(() => validateCandidatePull(pull(), repository, "c".repeat(40))).toThrow("changed");
	});
	it.each([
		[
			"closed",
			(value) => {
				value.state = "closed";
			},
		],
		[
			"merged",
			(value) => {
				value.merged_at = "2026-09-08";
			},
		],
		[
			"draft",
			(value) => {
				value.draft = true;
			},
		],
		[
			"human",
			(value) => {
				value.user.login = "maintainer";
			},
		],
		[
			"fork",
			(value) => {
				value.head.repo.full_name = "fork/leitwerk";
			},
		],
		[
			"ordinary branch",
			(value) => {
				value.head.ref = "feature";
			},
		],
		[
			"wrong base",
			(value) => {
				value.base.ref = "feature";
			},
		],
	] satisfies [
		string,
		(value: ReturnType<typeof pull>) => void,
	][])("rejects %s PRs", (_name, change) => {
		const value = pull();
		change(value);
		expect(() => validateCandidatePull(value, repository)).toThrow();
	});
	it("resolves the actual PR head through GitHub and rejects outdated bases", async () => {
		const fixture = await githubFixture();
		try {
			await expect(resolveCandidate(fixture.env)).resolves.toEqual({
				sha,
				version,
				baseVersion: "0.2.0",
			});
			await expect(
				resolveCandidate({ ...fixture.env, GITHUB_REF: "refs/heads/feature" }),
			).rejects.toThrow("from main");
		} finally {
			await fixture.close();
		}
		const outdated = await githubFixture({
			[`compare/${"b".repeat(40)}...${sha}`]: { status: "diverged" },
		});
		try {
			await expect(resolveCandidate(outdated.env)).rejects.toThrow("trusted workflow revision");
		} finally {
			await outdated.close();
		}
	});
});

describe("candidate package archives", () => {
	it("rewrites every internal dependency field and forces next without mutating the input", () => {
		const original = packageManifest();
		const result = candidateManifest(original, { version, sha, names });
		for (const field of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			expect(result[field]["@leitwerk-dev/b"]).toBe(version);
		}
		expect(result.dependencies.yaml).toBe("2.8.3");
		expect(result.publishConfig).toEqual({
			access: "public",
			registry: "https://registry.npmjs.org/",
			tag: "next",
			provenance: true,
		});
		expect(original.version).toBe("0.2.0");
		expect(original.publishConfig.tag).toBe("latest");
	});
	it("packs real npm workspaces without executing lifecycle hooks", () => {
		const source = temporary();
		const destination = temporary();
		json(path.join(source, "package.json"), {
			name: "fixture",
			private: true,
			version: "0.2.0",
			workspaces: ["packages/*"],
		});
		for (const entry of catalog) {
			json(path.join(source, entry.directory, "package.json"), packageManifest(entry.name));
			writeFileSync(path.join(source, entry.directory, "index.js"), "export const value = 1;\n");
		}
		const packages = prepareCandidate({ source, destination, version, sha, catalog });
		expect(packages.map((entry: { name: string }) => entry.name)).toEqual(
			catalog.map((entry) => entry.name),
		);
		for (const entry of catalog)
			expect(existsSync(path.join(source, entry.directory, "lifecycle-ran"))).toBe(false);
		expect(JSON.parse(readFileSync(path.join(source, "package.json"), "utf8")).version).toBe(
			"0.2.0",
		);
	});
	it("independently rejects tampered or extra publication artifacts", () => {
		const directory = archives();
		const checked = verifyCandidateArchives({ directory, version, sha, catalog });
		expect(checked).toHaveLength(2);
		expect(() =>
			verifyCandidateArchives({ directory, version, sha: "d".repeat(40), catalog }),
		).toThrow("unexpected identity");
		writeFileSync(path.join(directory, "extra.tgz"), "unexpected");
		expect(() => verifyCandidateArchives({ directory, version, sha, catalog })).toThrow(
			"exactly match",
		);
	});
	it("rejects an existing version with different contents or revision", () => {
		const archive = { name: "@leitwerk-dev/a", version, sha, integrity: "sha512-test" };
		const metadata = { version, gitHead: sha, dist: { integrity: "sha512-test" } };
		expect(() => validateExistingCandidate(metadata, archive)).not.toThrow();
		expect(() =>
			validateExistingCandidate({ ...metadata, gitHead: "b".repeat(40) }, archive),
		).toThrow();
		expect(() =>
			validateExistingCandidate({ ...metadata, dist: { integrity: "other" } }, archive),
		).toThrow();
	});
	it("does not allow an older run to move next backwards", () => {
		for (const current of [undefined, "0.1.9-rc.999", "0.2.0-rc.122", version]) {
			expect(() => validateNextTag(current, version)).not.toThrow();
		}
		for (const current of ["0.2.0-rc.124", "0.3.0-rc.1", "0.2.0", "unexpected"]) {
			expect(() => validateNextTag(current, version)).toThrow();
		}
	});
});

describe("opt-in publication", () => {
	it("publishes only verified tarballs to next, disables hooks, and safely resumes", async () => {
		const fixture = await githubFixture();
		const directory = archives();
		const entries = verifyCandidateArchives({ directory, version, sha, catalog });
		const published = new Map<string, unknown>();
		const writes: string[][] = [];
		const runNpm = (args: string[]) => {
			if (args[0] === "publish") {
				writes.push(args);
				const entry = entries.find((entry: { filename: string }) => entry.filename === args[1]);
				published.set(`${entry.name}@${version}`, {
					version,
					gitHead: sha,
					"dist.integrity": entry.integrity,
				});
				return { status: 0, stdout: "", stderr: "" };
			}
			if (args[2] === "dist-tags.next") return { status: 0, stdout: "", stderr: "" };
			return published.has(args[1])
				? { status: 0, stdout: JSON.stringify(published.get(args[1])), stderr: "" }
				: { status: 1, stdout: JSON.stringify({ error: { code: "E404" } }), stderr: "" };
		};
		const env = {
			...fixture.env,
			RC_PUBLISH: "true",
			RC_VERSION: version,
			RC_GIT_SHA: sha,
			RC_ARTIFACTS: directory,
		};
		try {
			await expect(
				publishCandidate({ ...env, RC_PUBLISH: "false" }, { runNpm, catalog }),
			).rejects.toThrow("explicit");
			expect(writes).toEqual([]);
			await publishCandidate(env, { runNpm, catalog });
			expect(writes).toHaveLength(2);
			for (const args of writes) {
				expect(args).toContain("--ignore-scripts");
				expect(args[args.indexOf("--tag") + 1]).toBe("next");
				expect(args).not.toContain("latest");
			}
			await publishCandidate(env, { runNpm, catalog });
			expect(writes).toHaveLength(2);
			published.delete(`@leitwerk-dev/a@${version}`);
			published.set(`@leitwerk-dev/b@${version}`, { version, gitHead: "wrong" });
			await expect(publishCandidate(env, { runNpm, catalog })).rejects.toThrow(
				"different contents",
			);
			expect(writes).toHaveLength(2);
		} finally {
			await fixture.close();
		}
	});
	it("fails closed on ambiguous registry results before any write", async () => {
		const fixture = await githubFixture();
		const writes: string[][] = [];
		try {
			await expect(
				publishCandidate(
					{
						...fixture.env,
						RC_PUBLISH: "true",
						RC_VERSION: version,
						RC_GIT_SHA: sha,
						RC_ARTIFACTS: archives(),
					},
					{
						catalog,
						runNpm: (args: string[]) => {
							if (args[0] === "publish") writes.push(args);
							return { status: 0, stdout: "", stderr: "" };
						},
					},
				),
			).rejects.toThrow("no package metadata");
			expect(writes).toEqual([]);
		} finally {
			await fixture.close();
		}
	});
	it("rejects a changed PR before inspecting or publishing registry contents", async () => {
		const changed = pull();
		changed.head.sha = "c".repeat(40);
		const fixture = await githubFixture({ "pulls/40": changed });
		let calls = 0;
		try {
			await expect(
				publishCandidate(
					{
						...fixture.env,
						RC_PUBLISH: "true",
						RC_VERSION: version,
						RC_GIT_SHA: sha,
						RC_ARTIFACTS: archives(),
					},
					{
						catalog,
						runNpm: () => {
							calls++;
							throw new Error("Registry should not be contacted");
						},
					},
				),
			).rejects.toThrow("changed during validation");
			expect(calls).toBe(0);
		} finally {
			await fixture.close();
		}
	});
	it("keeps PR execution outside the OIDC publisher and requires manual opt-in", () => {
		const workflow = parse(
			readFileSync(
				fileURLToPath(new URL("../.github/workflows/publish-rc.yml", import.meta.url)),
				"utf8",
			),
		);
		expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
		expect(workflow.on.workflow_dispatch.inputs.publish.default).toBe(false);
		expect(workflow.permissions).toEqual({ contents: "read" });
		expect(workflow.jobs.validate.permissions).toBeUndefined();
		expect(workflow.jobs.validate.environment).toBeUndefined();
		expect(workflow.jobs.publish.needs).toEqual(["resolve", "validate"]);
		expect(workflow.jobs.publish.if).toBe(`\${{ inputs.publish }}`);
		expect(workflow.jobs.publish.environment).toBe("npm-prerelease");
		expect(workflow.jobs.publish.permissions).toEqual({
			contents: "read",
			"pull-requests": "read",
			"id-token": "write",
		});
		const publisherSteps = workflow.jobs.publish.steps;
		expect(publisherSteps[0].with.ref).toBe(`\${{ github.sha }}`);
		expect(publisherSteps.some((step: { run?: string }) => step.run?.includes("npm ci"))).toBe(
			false,
		);
		expect(publisherSteps.at(-1).run).toBe("node scripts/release-candidate.mjs publish");
	});
});
