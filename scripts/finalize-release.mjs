import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function gh(args) {
	return execFileSync("gh", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	}).trim();
}

export function finalizeRelease({ repository, tag, sha, files }, run = gh) {
	if (
		!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") ||
		!/^v\d+\.\d+\.\d+$/u.test(tag ?? "") ||
		!/^[a-f0-9]{40}$/u.test(sha ?? "")
	) {
		throw new Error("Expected repository, stable release tag, and verified commit SHA");
	}
	const expected = [`leitwerk-${tag.slice(1)}.tgz`, "leitwerk-base.lock.yaml"];
	if (
		files.length !== expected.length ||
		files.some((file, index) => path.basename(file) !== expected[index])
	) {
		throw new Error("Expected the release chart and lock file");
	}
	const contents = files.map((file) => readFileSync(file));
	const view = () =>
		JSON.parse(
			run([
				"release",
				"view",
				tag,
				"--repo",
				repository,
				"--json",
				"databaseId,tagName,isDraft,isPrerelease,author,assets",
			]),
		);
	const checkTag = () => {
		const current = run(["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"]);
		if (current !== sha) throw new Error("Release tag moved since validation; refusing to publish");
	};
	const release = view();
	if (
		!Number.isSafeInteger(release.databaseId) ||
		release.tagName !== tag ||
		typeof release.isDraft !== "boolean" ||
		release.isPrerelease !== false ||
		release.author?.login !== "github-actions[bot]"
	) {
		throw new Error("Expected the stable Release Please release");
	}
	checkTag();
	const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-release-assets-"));
	try {
		const missing = [];
		// Check every existing asset before making any external writes.
		for (const [index, name] of expected.entries()) {
			const assets = release.assets.filter((asset) => asset.name === name);
			if (assets.length > 1) throw new Error(`Duplicate release asset: ${name}`);
			if (assets.length === 0) {
				missing.push(files[index]);
				continue;
			}
			run([
				"release",
				"download",
				tag,
				"--repo",
				repository,
				"--pattern",
				name,
				"--dir",
				directory,
			]);
			if (!readFileSync(path.join(directory, name)).equals(contents[index])) {
				throw new Error(`Release asset differs from validated contents: ${name}`);
			}
		}
		if (missing.length && !release.isDraft) {
			throw new Error(
				"Published release is missing assets; create a new version through the draft release workflow",
			);
		}
		for (const file of missing) run(["release", "upload", tag, file, "--repo", repository]);
		const current = view();
		if (
			current.databaseId !== release.databaseId ||
			current.isDraft !== release.isDraft ||
			expected.some((name) => !current.assets.some((asset) => asset.name === name))
		) {
			throw new Error("Release changed or an uploaded asset is missing; refusing to publish");
		}
		checkTag();
		if (release.isDraft) {
			run([
				"api",
				"--method",
				"PATCH",
				`repos/${repository}/releases/${release.databaseId}`,
				"-F",
				"draft=false",
			]);
		}
		console.info(
			`${tag}: release assets verified${release.isDraft ? "; draft published" : "; already published"}`,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	finalizeRelease({
		repository: process.env.GITHUB_REPOSITORY,
		tag: process.env.RELEASE_TAG,
		sha: process.env.RELEASE_GIT_SHA,
		files: [process.env.CHART_ARCHIVE, "release-artifacts/final/leitwerk-base.lock.yaml"],
	});
}
