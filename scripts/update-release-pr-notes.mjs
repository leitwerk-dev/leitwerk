import path from "node:path";
import { fileURLToPath } from "node:url";

const blockStart = "<!-- leitwerk-overall-release-notes:start -->";
const blockEnd = "<!-- leitwerk-overall-release-notes:end -->";

export function extractLatestChangelogRelease(changelog) {
	const normalized = changelog.replaceAll("\r\n", "\n");
	const headings = [...normalized.matchAll(/^## .+$/gmu)];
	if (headings.length === 0 || headings[0].index === undefined) {
		throw new Error("CHANGELOG.md has no release heading");
	}
	const start = headings[0].index;
	const end = headings[1]?.index ?? normalized.length;
	return normalized.slice(start, end).trim();
}

export function formatOverallReleaseNotes(changelog) {
	const release = extractLatestChangelogRelease(changelog).replace(/^(#{2,5})(?=\s)/gmu, "#$1");
	return `${blockStart}\n## Overall release notes\n\n${release}\n${blockEnd}`;
}

export function replaceGeneratedReleaseNotes(body, changelog) {
	const block = formatOverallReleaseNotes(changelog);
	const header = /^:robot:[^\n]*\n---/u.exec(body)?.[0];
	const footer = /---\nThis PR was generated with \[Release Please\][\s\S]*$/u.exec(body)?.[0];
	if (!header || !footer) {
		throw new Error("release PR body does not match the expected Release Please format");
	}
	return `${header}\n\n${block}\n\n${footer}`;
}

async function githubRequest(apiUrl, token, requestPath, init = {}) {
	const response = await fetch(`${apiUrl}${requestPath}`, {
		...init,
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"User-Agent": "leitwerk-release-pr-notes",
			"X-GitHub-Api-Version": "2022-11-28",
			...init.headers,
		},
	});
	if (!response.ok) {
		throw new Error(
			`GitHub API ${response.status} ${response.statusText}: ${await response.text()}`,
		);
	}
	return response.status === 204 ? undefined : response.json();
}

async function updateReleasePullRequest() {
	const repository = process.env.GITHUB_REPOSITORY;
	const token = process.env.GITHUB_TOKEN;
	const targetBranch = process.env.RELEASE_TARGET_BRANCH ?? "main";
	const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
	if (!repository || !token) {
		throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
	}

	const pulls = await githubRequest(
		apiUrl,
		token,
		`/repos/${repository}/pulls?state=open&base=${encodeURIComponent(targetBranch)}&per_page=100`,
	);
	const releasePulls = pulls.filter((pull) =>
		pull.head.ref.startsWith("release-please--branches--"),
	);
	if (releasePulls.length === 0) {
		console.info(`No open Release Please pull request targets ${targetBranch}`);
		return;
	}
	if (releasePulls.length > 1) {
		throw new Error(`found ${releasePulls.length} open Release Please pull requests`);
	}

	const pull = releasePulls[0];
	const changelogFile = await githubRequest(
		apiUrl,
		token,
		`/repos/${repository}/contents/CHANGELOG.md?ref=${encodeURIComponent(pull.head.sha)}`,
	);
	if (changelogFile.encoding !== "base64" || typeof changelogFile.content !== "string") {
		throw new Error("GitHub did not return CHANGELOG.md as base64 file content");
	}
	const changelog = Buffer.from(changelogFile.content, "base64").toString("utf8");
	const body = replaceGeneratedReleaseNotes(pull.body ?? "", changelog);
	if (body === pull.body) {
		console.info(`Release pull request #${pull.number} already has current overall notes`);
		return;
	}

	await githubRequest(apiUrl, token, `/repos/${repository}/pulls/${pull.number}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
	console.info(`Updated overall release notes in pull request #${pull.number}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) await updateReleasePullRequest();
