import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateYaml } from "./prepare-release-chart.ts";
import {
	calculateConventionalVersion,
	compareStableVersions,
	dependencyFields,
	readWorkspaceManifests,
	validateReleaseContract,
} from "./release-contract.ts";
import { readJson } from "./workspace-packages.ts";

const botName = "github-actions[bot]";
const botEmail = "41898282+github-actions[bot]@users.noreply.github.com";
const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const policyPath = "release-policy.json";

/** @internal */
export interface MainRelease {
	tag: string;
	version: string;
	source: string;
	previousTag: string;
}

/** @internal */
export interface GitHubRelease {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	author: { login: string };
}

/** @internal */
export interface ReleaseRegistry {
	list(): GitHubRelease[];
	create(tag: string, notes: string): void;
}

function git(root: string, args: string[], input?: string, env = process.env): string {
	return execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args], {
		encoding: "utf8",
		input,
		env,
		maxBuffer: 32 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
	}).trimEnd();
}

function lines(text: string): string[] {
	return text ? text.split("\n") : [];
}

function commitMessage(release: MainRelease): string {
	return [
		`chore(release): ${release.tag}`,
		"",
		`Release-Source: ${release.source}`,
		`Release-Previous: ${release.previousTag}`,
		"",
		`Signed-off-by: ${botName} <${botEmail}>`,
		"",
	].join("\n");
}

function releaseNotes(root: string, release: MainRelease): string {
	const message = git(root, ["show", "-s", "--format=%B", release.source]);
	const notes = message
		.split("\n")
		.filter((line) => !/^(?:Signed-off-by|Co-authored-by|Release-As):/iu.test(line))
		.join("\n")
		.trim();
	return `${notes}\n\nSource: ${release.source}\nPrevious release: ${release.previousTag}\n`;
}

function updateVersions(root: string, version: string) {
	const manifest = readJson<Record<string, unknown>>(path.join(root, "package.json"));
	const manifests = readWorkspaceManifests(root, manifest);
	const names = new Set(manifests.map((entry) => entry.manifest.name));
	const update = (value: Record<string, unknown>) => {
		value.version = version;
		for (const field of dependencyFields) {
			const dependencies = value[field] as Record<string, string> | undefined;
			for (const name of Object.keys(dependencies ?? {})) {
				if (names.has(name) && dependencies) dependencies[name] = version;
			}
		}
	};
	const writeJson = (filename: string, value: unknown) =>
		writeFileSync(path.join(root, filename), `${JSON.stringify(value, null, "\t")}\n`);
	update(manifest);
	writeJson("package.json", manifest);
	for (const entry of manifests) {
		update(entry.manifest);
		writeJson(`${entry.path}/package.json`, entry.manifest);
	}
	// Update only local lock records. Never resolve or install dependencies while versioning.
	const lock = readJson<Record<string, unknown>>(path.join(root, "package-lock.json"));
	lock.version = version;
	const packages = lock.packages as Record<string, Record<string, unknown>>;
	for (const workspace of ["", ...manifests.map((entry) => entry.path)]) {
		if (!packages[workspace]) throw new Error(`Missing workspace lock record: ${workspace}`);
		update(packages[workspace]);
	}
	writeJson("package-lock.json", lock);

	const chartDir = path.join(root, "deploy/kubernetes/helm/leitwerk");
	updateYaml(path.join(chartDir, "Chart.yaml"), 80, (document) => {
		document.set("version", version);
		document.set("appVersion", version);
	});
	updateYaml(path.join(chartDir, "values.yaml"), 80, (document) => {
		document.setIn(["server", "image", "tag"], version);
		document.setIn(
			["workerRuntimeProfiles", "generic", "image"],
			`ghcr.io/leitwerk-dev/leitwerk-worker-generic:${version}`,
		);
	});
}

/** Build a reproducible, signed-off release commit without changing main or executing source hooks.
 * @internal
 */
export function prepareReleaseCommit(root: string, release: MainRelease): string {
	const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-release-"));
	try {
		git(root, ["clone", "--shared", "--no-checkout", root, directory]);
		git(directory, ["-c", "core.autocrlf=false", "checkout", "--detach", release.source]);
		updateVersions(directory, release.version);
		const previousChangelog = git(root, ["show", `${release.previousTag}:CHANGELOG.md`]);
		const date = git(root, ["show", "-s", "--format=%cs", release.source]);
		writeFileSync(
			path.join(directory, "CHANGELOG.md"),
			`# Changelog\n\n## ${release.version} (${date})\n\n${releaseNotes(root, release)}\n${previousChangelog.replace(/^# Changelog\s*/u, "")}\n`,
		);
		const errors = validateReleaseContract(directory);
		if (errors.length) throw new Error(`Invalid release contents:\n${errors.join("\n")}`);
		git(directory, ["-c", "core.hooksPath=/dev/null", "add", "--all"]);
		const tree = git(directory, ["write-tree"]);
		const dateTime = git(root, ["show", "-s", "--format=%cI", release.source]);
		const sha = git(
			directory,
			["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", release.source],
			commitMessage(release),
			{
				...process.env,
				GIT_AUTHOR_NAME: botName,
				GIT_AUTHOR_EMAIL: botEmail,
				GIT_COMMITTER_NAME: botName,
				GIT_COMMITTER_EMAIL: botEmail,
				GIT_AUTHOR_DATE: dateTime,
				GIT_COMMITTER_DATE: dateTime,
			},
		);
		git(root, ["fetch", "--no-tags", directory, sha]);
		return sha;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function* releaseSequence(root: string, main: string, baselineTag: string): Generator<MainRelease> {
	// The first main commit adding the policy is the cutover. Do not backfill old merges.
	const activations = lines(
		git(root, ["log", "--first-parent", "--diff-filter=A", "--format=%H", main, "--", policyPath]),
	);
	if (activations.length !== 1) throw new Error("Expected one release policy activation on main");
	const activation = activations[0];
	const initialPolicy = JSON.parse(git(root, ["show", `${activation}:${policyPath}`]));
	if (initialPolicy.baselineTag !== baselineTag)
		throw new Error("Release baseline cannot change after activation");
	const commits = git(root, [
		"log",
		"--first-parent",
		"--reverse",
		"--format=%H%x00%B%x00",
		`${activation}^..${main}`,
	]).split("\0");
	let previousTag = baselineTag;
	for (let index = 0; index < commits.length - 1; index += 2) {
		const source = commits[index].trim();
		// Read the policy at the source commit so upgrades never renumber historical releases.
		const sourcePolicy = JSON.parse(git(root, ["show", `${source}:${policyPath}`]));
		const version = calculateConventionalVersion(
			previousTag.slice(1),
			commits[index + 1],
			sourcePolicy.releaseAllTypes === true,
		);
		if (!version) continue;
		const tag = `v${version}`;
		yield { source, tag, version, previousTag };
		previousTag = tag;
	}
}

function validateGitHubRelease(release: GitHubRelease, tag: string) {
	if (
		release.tag_name !== tag ||
		typeof release.draft !== "boolean" ||
		release.prerelease !== false ||
		release.author?.login !== botName
	)
		throw new Error(`Expected an automation-owned stable GitHub Release: ${tag}`);
}

/** Process the oldest unfinished release; git tags reserve versions across interrupted runs.
 * @internal
 */
export function resolveMainRelease({
	root,
	registry,
	assertValidated,
}: {
	root: string;
	registry: ReleaseRegistry;
	assertValidated: (source: string) => void;
}): (MainRelease & { sha: string }) | null {
	git(root, ["fetch", "origin", "main", "--tags"]);
	const main = git(root, ["rev-parse", "refs/remotes/origin/main"]);
	const { baselineTag } = readJson(path.join(root, policyPath));
	if (typeof baselineTag !== "string" || !stableTag.test(baselineTag))
		throw new Error("Expected a stable baselineTag");
	// Batch history and tag reads: scanning an old queue must not spawn a process per merge.
	const tagFields = git(root, [
		"for-each-ref",
		"--format=%(refname:lstrip=2)%00%(contents)%00%(parent)%00",
		"refs/tags",
	]).split("\0");
	const tagRecords = new Map<string, { message: string; parents: string }>();
	for (let index = 0; index < tagFields.length - 1; index += 3) {
		tagRecords.set(tagFields[index].trim(), {
			message: tagFields[index + 1].trimEnd(),
			parents: tagFields[index + 2],
		});
	}
	const tags = [...tagRecords.keys()]
		.filter(
			(tag) => stableTag.test(tag) && compareStableVersions(tag.slice(1), baselineTag.slice(1)) > 0,
		)
		.sort((a, b) => compareStableVersions(a.slice(1), b.slice(1)));
	const releases = new Map(registry.list().map((release) => [release.tag_name, release]));
	const baseline = releases.get(baselineTag);
	if (!baseline || baseline.draft)
		throw new Error("Publish the baseline release before enabling automatic releases");
	validateGitHubRelease(baseline, baselineTag);
	for (const tag of releases.keys()) {
		if (
			stableTag.test(tag) &&
			compareStableVersions(tag.slice(1), baselineTag.slice(1)) > 0 &&
			!tags.includes(tag)
		) {
			throw new Error(`Release has no immutable reservation tag: ${tag}`);
		}
	}
	const sequence = releaseSequence(root, main, baselineTag);
	let pending: MainRelease | undefined;
	for (const [index, tag] of tags.entries()) {
		const expected = sequence.next().value;
		if (!expected || expected.tag !== tag)
			throw new Error(`Unexpected release tag or skipped merge: ${tag}`);
		const record = tagRecords.get(tag);
		if (
			record?.message !== commitMessage(expected).trimEnd() ||
			record.parents !== expected.source
		) {
			throw new Error(`Release tag does not match its main source: ${tag}`);
		}
		const release = releases.get(tag);
		if (release) validateGitHubRelease(release, tag);
		if (!release || release.draft) {
			if (index !== tags.length - 1)
				throw new Error(`Unfinished release precedes newer tags: ${tag}`);
			pending = expected;
		}
	}
	const selected = pending ?? sequence.next().value;
	if (!selected) return null;
	// Both the release source and the publication tooling must have passed main CI.
	// Check before reserving a tag or creating a draft, including on scheduled recovery.
	for (const source of new Set([selected.source, git(root, ["rev-parse", "HEAD"])])) {
		assertValidated(source);
	}
	const sha = prepareReleaseCommit(root, selected);
	if (tags.includes(selected.tag)) {
		if (git(root, ["rev-parse", `${selected.tag}^{commit}`]) !== sha) {
			throw new Error(`Release tag contents differ from the verified main source: ${selected.tag}`);
		}
	} else {
		// Push first: a crash before draft creation is repaired from this immutable reservation.
		git(root, ["push", "origin", `${sha}:refs/tags/${selected.tag}`]);
		git(root, ["update-ref", `refs/tags/${selected.tag}`, sha, ""]);
	}
	if (!releases.has(selected.tag)) registry.create(selected.tag, releaseNotes(root, selected));
	return { ...selected, sha };
}

/** @internal */
export function assertReleaseContext(env: NodeJS.ProcessEnv) {
	if (
		env.GITHUB_REF !== "refs/heads/main" ||
		!["workflow_run", "schedule"].includes(env.GITHUB_EVENT_NAME ?? "") ||
		env.RELEASE_TAG
	) {
		throw new Error("Publication must run from main after CI or on schedule, without overrides");
	}
}

/** @internal */
export function assertSuccessfulMainCi(
	runs: { head_sha: string; head_branch: string; event: string; conclusion: string | null }[],
	source: string,
) {
	if (
		!runs.some(
			(run) =>
				run.head_sha === source &&
				run.head_branch === "main" &&
				run.event === "push" &&
				run.conclusion === "success",
		)
	) {
		throw new Error(`Main CI has not succeeded for ${source}`);
	}
}

function githubRegistry(repository: string): ReleaseRegistry {
	const api = (args: string[], input?: unknown) =>
		JSON.parse(
			execFileSync("gh", ["api", ...args], {
				encoding: "utf8",
				input: input === undefined ? undefined : JSON.stringify(input),
				maxBuffer: 32 * 1024 * 1024,
			}),
		);
	return {
		list: () => api(["--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]).flat(),
		create: (tag, notes) => {
			api(["--method", "POST", `repos/${repository}/releases`, "--input", "-"], {
				tag_name: tag,
				name: tag,
				body: notes,
				draft: true,
				prerelease: false,
			});
		},
	};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	assertReleaseContext(process.env);
	const { GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: output } = process.env;
	if (!repository || !/^[\w.-]+\/[\w.-]+$/u.test(repository) || !output)
		throw new Error("GITHUB_REPOSITORY and GITHUB_OUTPUT are required");
	const release = resolveMainRelease({
		root: fileURLToPath(new URL("../", import.meta.url)),
		registry: githubRegistry(repository),
		assertValidated: (source) => {
			const pages = JSON.parse(
				execFileSync(
					"gh",
					[
						"api",
						"--paginate",
						"--slurp",
						`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${source}&event=push&per_page=100`,
					],
					{ encoding: "utf8" },
				),
			);
			assertSuccessfulMainCi(
				pages.flatMap((page: { workflow_runs: [] }) => page.workflow_runs),
				source,
			);
		},
	});
	appendFileSync(
		output,
		release
			? `release=true\nversion=${release.version}\ntag=${release.tag}\ngit_sha=${release.sha}\n`
			: "release=false\n",
	);
	console.info(
		release
			? `${release.tag}: ${release.source} → ${release.sha}`
			: "No pending release-producing merges",
	);
}
