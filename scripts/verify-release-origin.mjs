import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function validateReleaseOrigin({ repository, tag, sha, release, comparison, pull }) {
	if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error("Expected a stable vX.Y.Z tag");
	if (
		release.tag_name !== tag ||
		release.draft !== false ||
		release.prerelease !== false ||
		release.author?.login !== "github-actions[bot]"
	) {
		throw new Error("Expected a published stable GitHub Release created by Release Please");
	}
	if (!["ahead", "identical"].includes(comparison.status)) {
		throw new Error("Release commit must be on main");
	}
	if (
		!pull?.merged_at ||
		pull.merge_commit_sha !== sha ||
		pull.user?.login !== "github-actions[bot]" ||
		pull.head?.ref !== "release-please--branches--main" ||
		pull.head?.repo?.full_name !== repository ||
		pull.base?.ref !== "main" ||
		pull.base?.repo?.full_name !== repository
	) {
		throw new Error("Release tag must point to a merged Release Please PR in this repository");
	}
}

export async function verifyReleaseOrigin(env = process.env) {
	const { GITHUB_REPOSITORY: repository, GH_TOKEN: token, RELEASE_TAG: tag } = env;
	if (env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
		throw new Error("Publication must be dispatched from main");
	}
	if (!repository || !token || !tag || !env.GITHUB_OUTPUT) {
		throw new Error("GITHUB_REPOSITORY, GH_TOKEN, RELEASE_TAG, and GITHUB_OUTPUT are required");
	}
	if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error("Expected a stable vX.Y.Z tag");
	const apiUrl = env.GITHUB_API_URL ?? "https://api.github.com";
	async function get(endpoint) {
		const response = await fetch(`${apiUrl}/repos/${repository}/${endpoint}`, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!response.ok)
			throw new Error(`GitHub release verification failed: HTTP ${response.status}`);
		return response.json();
	}
	const release = await get(`releases/tags/${tag}`);
	let { object } = await get(`git/ref/tags/${tag}`);
	for (let depth = 0; object.type === "tag" && depth < 8; depth++) {
		({ object } = await get(`git/tags/${object.sha}`));
	}
	if (object.type !== "commit" || !/^[a-f0-9]{40}$/u.test(object.sha)) {
		throw new Error("Release tag must resolve to a Git commit");
	}
	const sha = object.sha;
	const comparison = await get(`compare/${sha}...main`);
	let pull;
	for (let page = 1; ; page++) {
		const pulls = await get(`commits/${sha}/pulls?per_page=100&page=${page}`);
		pull = pulls.find((candidate) => candidate.merge_commit_sha === sha && candidate.merged_at);
		if (pull || pulls.length < 100) break;
	}
	validateReleaseOrigin({ repository, tag, sha, release, comparison, pull });
	appendFileSync(env.GITHUB_OUTPUT, `git_sha=${sha}\n`);
	console.info(`Verified ${tag} at ${sha} from merged release PR #${pull.number}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await verifyReleaseOrigin();
}
